"""One source for this month's BigQuery bytes: INFORMATION_SCHEMA by service account or label, sent to the
production Coordinator as a floor; the runner reports every byte a job bills, failed attempts included."""

from types import SimpleNamespace

import sqlglot

from peoplelake.prod import doctor_gcp
from peoplelake.prod.doctor_gcp import MONTH_BILLED_SQL, report_month_to_production
from peoplelake.runner.jobs import Faults, billed_total, run_transform, seed_checksum


def test_the_month_query_counts_service_accounts_and_labeled_jobs():
    sqlglot.parse_one(MONTH_BILLED_SQL, read="bigquery")
    assert "STARTS_WITH(user_email, 'peoplelake-')" in MONTH_BILLED_SQL
    assert "l.key = 'app' AND l.value = 'peoplelake'" in MONTH_BILLED_SQL


def test_the_month_total_goes_to_production_only_when_it_is_set_up(tmp_path, monkeypatch):
    monkeypatch.setattr(doctor_gcp, "repo_root", lambda: tmp_path)
    assert report_month_to_production(5) is None
    (tmp_path / ".prod").mkdir()
    (tmp_path / ".prod" / "state.json").write_text("{}")
    sent = []
    operator = SimpleNamespace(bq_month=lambda month, b: sent.append((month, b)) or {"ok": True})
    monkeypatch.setattr("peoplelake.evals.freshness.prod_operator", lambda: operator)
    assert report_month_to_production(274_000_000_000, "2026-10") == {"ok": True}
    assert sent == [("2026-10", 274_000_000_000)]


def test_the_drill_guard_reports_to_production_and_survives_a_failure(monkeypatch):
    from peoplelake.evals.scenarios import DrillTarget

    monkeypatch.setattr("peoplelake.warehouse.bigquery_wh.bigquery_client", lambda *a, **k: object())
    monkeypatch.setattr(doctor_gcp, "month_bytes_billed", lambda client: 123)
    reported = []
    monkeypatch.setattr(doctor_gcp, "report_month_to_production", lambda b: reported.append(b))
    target = DrillTarget(project="p", location="US", runner_sa="r", runner_env={})
    assert target.month_billed() == 123 and reported == [123]

    def down(b):
        raise RuntimeError("worker unreachable")

    monkeypatch.setattr(doctor_gcp, "report_month_to_production", down)
    assert target.month_billed() == 123


def test_every_result_carries_all_bytes_the_job_billed():
    bq = SimpleNamespace(kind="bigquery", bytes_billed=40)
    assert billed_total({"status": "failed"}, bq, dbt_bytes=2)["bytes_billed"] == 42
    assert "bytes_billed" not in billed_total({"status": "succeeded"}, SimpleNamespace(kind="duckdb"))
    assert "bytes_billed" not in billed_total({"status": "failed"}, None)


def test_a_failed_dbt_build_reports_the_bytes_it_billed():
    warehouse = SimpleNamespace(
        kind="bigquery", bytes_billed=10_485_760, seed_checksum=seed_checksum, max_load_seq=lambda base, t: 1
    )
    dbt = SimpleNamespace(
        build=lambda **kw: SimpleNamespace(
            success=False, bytes_billed=2_000_000_000, failed_nodes=["model.p.x"], models_error=1, tests_error=0
        )
    )
    job = {"job_id": "j", "run_id": "r", "attempt": 1, "input": {"full_refresh": False}}
    result = run_transform(job, warehouse=warehouse, dbt=dbt, upload=None, profile="full", faults=Faults())
    assert result["status"] == "failed" and result["bytes_billed"] == 2_010_485_760
