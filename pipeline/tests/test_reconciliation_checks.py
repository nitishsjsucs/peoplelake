"""Each reconciliation check passes on the clean small profile and fires when its invariant is broken."""

import pytest

from dbt_helpers import make_env
from peoplelake.warehouse.duckdb_wh import connection

pytestmark = pytest.mark.dbt


@pytest.fixture(scope="module")
def built(tmp_path_factory, small):
    mp = pytest.MonkeyPatch()
    env = make_env(tmp_path_factory.mktemp("recon"), mp, small)
    env.load(env.items)
    outcome = env.dbt.build()
    assert outcome.success, outcome.failed_nodes
    assert outcome.tests_warn == 0 and set(outcome.checks_warn.values()) == {0}
    assert set(outcome.checks_warn) == {
        "recon_offer_to_hire",
        "recon_event_counts_vs_manifest",
        "recon_metrics_vs_oracle",
        "recon_anomalies_open",
    }
    yield env
    mp.undo()


def run_check(env, name):
    return env.dbt.invoke(["test", "--select", name])


def first(env, sql):
    return env.wh.query_arrow(sql).to_pylist()[0]


TAMPERS = {
    # name: (severity, tamper SQL, undo SQL)
    "recon_headcount_roll_forward_company": (
        "error",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET headcount = headcount + 1 WHERE department_id = 'ALL' AND month = DATE '2024-05-01'",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET headcount = headcount - 1 WHERE department_id = 'ALL' AND month = DATE '2024-05-01'",
    ),
    "recon_headcount_roll_forward_department": (
        "error",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET transfers_in = transfers_in + 1 WHERE department_id = 'D03' AND month = DATE '2024-05-01'",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET transfers_in = transfers_in - 1 WHERE department_id = 'D03' AND month = DATE '2024-05-01'",
    ),
    "recon_rehire_continuity": (
        "error",
        "UPDATE peoplelake_staging.int_hris__spells SET spell_no = 1 WHERE hire_event_type = 'worker.rehired' AND employee_id = (SELECT min(employee_id) FROM peoplelake_staging.int_hris__spells WHERE spell_no = 2)",
        "UPDATE peoplelake_staging.int_hris__spells SET spell_no = 2 WHERE hire_event_type = 'worker.rehired' AND spell_no = 1",
    ),
    "recon_history_contiguity": (
        "error",
        "UPDATE peoplelake_core.dim_employee_history SET valid_to = valid_to - INTERVAL 1 DAY WHERE employee_id = 'E000001' AND valid_from = (SELECT min(valid_from) FROM peoplelake_core.dim_employee_history WHERE employee_id = 'E000001')",
        "UPDATE peoplelake_core.dim_employee_history SET valid_to = valid_to + INTERVAL 1 DAY WHERE employee_id = 'E000001' AND valid_from = (SELECT min(valid_from) FROM peoplelake_core.dim_employee_history WHERE employee_id = 'E000001')",
    ),
    "recon_metrics_vs_oracle": (
        "warn",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET hires = hires + 1 WHERE department_id = 'D01' AND month = DATE '2025-01-01'",
        "UPDATE peoplelake_core.metrics_workforce_monthly SET hires = hires - 1 WHERE department_id = 'D01' AND month = DATE '2025-01-01'",
    ),
    "recon_event_counts_vs_manifest": (
        "warn",
        "UPDATE peoplelake_ops.expected_event_counts SET expected_count = expected_count + 1 WHERE profile = 'small' AND event_type = 'worker.hired'",
        "UPDATE peoplelake_ops.expected_event_counts SET expected_count = expected_count - 1 WHERE profile = 'small' AND event_type = 'worker.hired'",
    ),
    "recon_anomalies_open": (
        "warn",
        "INSERT INTO peoplelake_ops.ops_anomalies VALUES ('orphan_correction', 'E000001', 'x', DATE '2024-01-01')",
        "DELETE FROM peoplelake_ops.ops_anomalies WHERE event_id = 'x'",
    ),
}


@pytest.mark.parametrize("name", sorted(TAMPERS))
def test_check_fires_when_invariant_breaks(built, name):
    severity, tamper, undo = TAMPERS[name]
    with connection(built.wh.path) as con:
        con.execute(tamper)
    try:
        outcome = run_check(built, name)
        if severity == "error":
            assert not outcome.success
            assert outcome.checks_error.get(name, 0) > 0
        else:
            assert outcome.success
            assert outcome.checks_warn.get(name, 0) > 0
    finally:
        with connection(built.wh.path) as con:
            con.execute(undo)
    assert run_check(built, name).success


def test_r4_detects_superseded_department(built):
    row = first(
        built,
        """
        SELECT c.corrects_event_id AS target, t.employee_id, t.effective_date, t.to_department_id AS superseded
        FROM peoplelake_staging.stg_hris__worker_events c
        JOIN peoplelake_staging.stg_hris__worker_events t ON t.event_id = c.corrects_event_id
        WHERE c.corrected_to_department_id IS NOT NULL
        ORDER BY 1 NULLS LAST LIMIT 1
        """,
    )
    with connection(built.wh.path) as con:
        original = con.execute(
            "SELECT department_id FROM peoplelake_core.dim_employee_history WHERE employee_id = ? AND valid_from = ?",
            [row["employee_id"], row["effective_date"]],
        ).fetchone()[0]
        con.execute(
            "UPDATE peoplelake_core.dim_employee_history SET department_id = ? WHERE employee_id = ? AND valid_from = ?",
            [row["superseded"], row["employee_id"], row["effective_date"]],
        )
    try:
        outcome = run_check(built, "recon_retro_corrections_applied")
        assert outcome.checks_error.get("recon_retro_corrections_applied", 0) > 0
    finally:
        with connection(built.wh.path) as con:
            con.execute(
                "UPDATE peoplelake_core.dim_employee_history SET department_id = ? WHERE employee_id = ? AND valid_from = ?",
                [original, row["employee_id"], row["effective_date"]],
            )
    assert run_check(built, "recon_retro_corrections_applied").success


def test_r5_detects_departure_for_rescinded_termination(built):
    rescinded = first(
        built,
        "SELECT rescinds_event_id AS id, employee_id FROM peoplelake_staging.stg_hris__worker_events "
        "WHERE event_type = 'worker.event_rescinded' ORDER BY 1 NULLS LAST LIMIT 1",
    )
    with connection(built.wh.path) as con:
        con.execute(
            "INSERT INTO peoplelake_core.fct_employment_events (event_id, employee_id, spell_no, event_kind, effective_date, is_corrected) "
            "VALUES (?, ?, 1, 'termination', DATE '2024-01-01', false)",
            [rescinded["id"], rescinded["employee_id"]],
        )
    try:
        outcome = run_check(built, "recon_rescinded_terminations_excluded")
        assert outcome.checks_error.get("recon_rescinded_terminations_excluded", 0) > 0
    finally:
        with connection(built.wh.path) as con:
            con.execute("DELETE FROM peoplelake_core.fct_employment_events WHERE event_id = ?", [rescinded["id"]])


def test_r6_detects_accepted_offer_without_hire(built):
    spell = first(
        built,
        "SELECT employee_id, spell_no, ats_candidate_id FROM peoplelake_staging.int_hris__spells "
        "WHERE ats_candidate_id IS NOT NULL ORDER BY 1 NULLS LAST LIMIT 1",
    )
    with connection(built.wh.path) as con:
        con.execute(
            "UPDATE peoplelake_staging.int_hris__spells SET ats_candidate_id = 'C999999' WHERE employee_id = ? AND spell_no = ?",
            [spell["employee_id"], spell["spell_no"]],
        )
    try:
        outcome = run_check(built, "recon_offer_to_hire")
        assert outcome.checks_warn.get("recon_offer_to_hire", 0) >= 2  # both sides of the match break
    finally:
        with connection(built.wh.path) as con:
            con.execute(
                "UPDATE peoplelake_staging.int_hris__spells SET ats_candidate_id = ? WHERE employee_id = ? AND spell_no = ?",
                [spell["ats_candidate_id"], spell["employee_id"], spell["spell_no"]],
            )


def test_r8_detects_payload_conflict(built):
    with connection(built.wh.path) as con:
        con.execute(
            "INSERT INTO peoplelake_raw.raw_event_deliveries SELECT * REPLACE ('conflict-delivery' AS delivery_id, "
            "repeat('0', 64) AS payload_sha256) FROM peoplelake_raw.raw_event_deliveries LIMIT 1"
        )
    try:
        outcome = run_check(built, "recon_no_event_id_conflicts")
        assert outcome.checks_error.get("recon_no_event_id_conflicts", 0) == 1
    finally:
        with connection(built.wh.path) as con:
            con.execute("DELETE FROM peoplelake_raw.raw_event_deliveries WHERE delivery_id = 'conflict-delivery'")
