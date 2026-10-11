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
    # The point-in-time macro pl_employee_as_of over the SCD2 history must agree with the monthly snapshot:
    # end one active employee's interval covering 2024-09-30 on that day, so the as-of view loses them.
    "recon_history_as_of_matches_snapshot": (
        "error",
        """
        CREATE OR REPLACE TABLE peoplelake_ops.tamper_as_of AS
        SELECT h.employee_id, h.valid_from, h.valid_to FROM peoplelake_core.dim_employee_history h
        JOIN peoplelake_core.fct_workforce_monthly f ON f.employee_id = h.employee_id AND f.month_end = DATE '2024-09-30'
        WHERE h.valid_from <= DATE '2024-09-30' AND h.valid_to > DATE '2024-09-30'
        ORDER BY h.employee_id LIMIT 1;
        UPDATE peoplelake_core.dim_employee_history AS h SET valid_to = DATE '2024-09-30'
        FROM peoplelake_ops.tamper_as_of t WHERE h.employee_id = t.employee_id AND h.valid_from = t.valid_from
        """,
        """
        UPDATE peoplelake_core.dim_employee_history AS h SET valid_to = t.valid_to
        FROM peoplelake_ops.tamper_as_of t WHERE h.employee_id = t.employee_id AND h.valid_from = t.valid_from;
        DROP TABLE peoplelake_ops.tamper_as_of
        """,
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


def test_every_reconciliation_check_has_a_test_that_breaks_it():
    """The module docstring's promise, checked: each check under tests/reconciliation is broken on purpose
    by a TAMPERS entry or a dedicated test in this module."""
    from pathlib import Path

    from peoplelake.paths import repo_root

    checks = {p.stem for p in (repo_root() / "warehouse" / "tests" / "reconciliation").glob("*.sql")}
    dedicated = {
        "recon_retro_corrections_applied",  # R4
        "recon_rescinded_terminations_excluded",  # R5
        "recon_offer_to_hire",  # R6
        "recon_no_event_id_conflicts",  # R8
    }
    source = Path(__file__).read_text()
    for name in dedicated:
        assert f'outcome = run_check(built, "{name}")' in source, name
    assert checks == set(TAMPERS) | dedicated


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


def test_secondary_suppression_hides_a_second_cell_and_its_check_has_teeth(built):
    """A month where exactly one department has fewer than 5 offer decisions: primary suppression alone
    would let ALL minus the shown departments recover it. rpt_metrics_monthly also hides the next smallest
    department, and rpt_no_recoverable_offer_cell fails on a primary-only view."""
    month = "DATE '2024-05-01'"
    mart = "peoplelake_core.metrics_workforce_monthly"
    view = "peoplelake_reporting.rpt_metrics_monthly"
    with connection(built.wh.path) as con:
        con.execute(
            f"CREATE OR REPLACE TABLE peoplelake_ops.tamper_offers AS SELECT * FROM {mart} WHERE month = {month}"
        )
        con.execute(
            f"""UPDATE {mart} SET
                offers_accepted = CASE WHEN department_id = 'D01' THEN 3 ELSE 10 + CAST(substr(department_id, 2) AS INTEGER) END,
                offers_declined = CASE WHEN department_id = 'D01' THEN 0 ELSE 2 END
              WHERE month = {month} AND department_id <> 'ALL'"""
        )
        con.execute(
            f"""UPDATE {mart} SET
                offers_accepted = (SELECT sum(offers_accepted) FROM {mart} WHERE month = {month} AND department_id <> 'ALL'),
                offers_declined = (SELECT sum(offers_declined) FROM {mart} WHERE month = {month} AND department_id <> 'ALL')
              WHERE month = {month} AND department_id = 'ALL'"""
        )
        view_sql = con.execute(
            "SELECT sql FROM duckdb_views() WHERE schema_name = 'peoplelake_reporting' AND view_name = 'rpt_metrics_monthly'"
        ).fetchone()[0]
    try:
        hidden = (
            built.wh.query_arrow(
                f"SELECT department_id FROM {view} WHERE month = {month} AND offers_suppressed ORDER BY 1"
            )
            .column(0)
            .to_pylist()
        )
        assert hidden == ["D01", "D02"]  # D01 (3 decisions) and the smallest shown department (D02, 14)
        assert run_check(built, "rpt_no_recoverable_offer_cell").success
        with connection(built.wh.path) as con:
            con.execute(
                f"CREATE OR REPLACE VIEW {view} AS SELECT m.*, false AS workforce_suppressed, "
                f"m.offers_accepted + m.offers_declined < 5 AS offers_suppressed FROM {mart} AS m"
            )
        outcome = run_check(built, "rpt_no_recoverable_offer_cell")
        assert not outcome.success
        assert outcome.checks_error.get("rpt_no_recoverable_offer_cell", 0) > 0
    finally:
        with connection(built.wh.path) as con:
            con.execute(f"DROP VIEW {view}")
            con.execute(view_sql)
            con.execute(f"DELETE FROM {mart} WHERE month = {month}")
            con.execute(f"INSERT INTO {mart} SELECT * FROM peoplelake_ops.tamper_offers")
            con.execute("DROP TABLE peoplelake_ops.tamper_offers")
    assert run_check(built, "rpt_no_recoverable_offer_cell").success
