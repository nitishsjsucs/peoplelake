"""Runner jobs against an in-memory Worker: results satisfy the contracts and eval faults behave."""

import hashlib
import json
from collections import Counter

import pytest
from pydantic import TypeAdapter

from dbt_helpers import make_env
from peoplelake import contracts as c
from peoplelake.config import load_settings
from peoplelake.lake.committer import LandingRoll
from peoplelake.runner.main import Runner
from peoplelake.warehouse.direct import direct_table

pytestmark = pytest.mark.dbt


class FakeWorker:
    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.results: list[tuple[str, dict]] = []
        self.artifacts: dict[str, str] = {}

    def heartbeat(self, job_id, worker_id):
        return True

    def result(self, job_id, result):
        dup = any(j == job_id for j, _ in self.results)
        self.results.append((job_id, result))
        return {"duplicate": dup}

    def put_metrics(self, run_id, body):
        self.artifacts[run_id] = body
        return {"key": f"reports/metrics/{run_id}.json", "sha256": hashlib.sha256(body.encode()).hexdigest()}

    def lake_files(self, prefix=None, after=None):
        keys = sorted(
            k for k in self.files if k.startswith(prefix or "landing/raw_events/") and (after is None or k > after)
        )
        return [LandingRoll(k, hashlib.md5(self.files[k]).hexdigest(), len(self.files[k])) for k in keys]

    def lake_file(self, key):
        return self.files[key]


def roll_file(items) -> bytes:
    rows = direct_table(items).to_pylist()
    for r in rows:
        for col in ("source_updated_at", "received_at"):
            r[col] = r[col].strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return "".join(json.dumps(r) + "\n" for r in rows).encode()


PREFIX = "landing/raw_events/g1790000000/"


def job(kind, attempt=1, faults=None, load_seq=1_790_000_000_000_001, from_snapshot=None):
    spec = {
        "job_id": f"r-test-000001-{kind}-a{attempt}",
        "run_id": "r-test-000001",
        "load_seq": load_seq,
        "kind": kind,
        "attempt": attempt,
        "mode": "incremental",
        "input": {"from_snapshot": from_snapshot, "full_refresh": False},
        "lease_seconds": 60,
    }
    if kind == "load":
        spec["input"]["landing_prefix"] = PREFIX
    if faults:
        spec["faults"] = faults
    return spec


@pytest.fixture
def runner(tmp_path, monkeypatch, small):
    env = make_env(tmp_path, monkeypatch, small)  # seeds the warehouse at PL_DUCKDB_PATH
    monkeypatch.setenv("PL_LAKE_DIR", str(tmp_path / "lake"))
    files = {f"{PREFIX}r{i:010d}.ndjson": roll_file(env.items[(i - 1) * 2500 : i * 2500]) for i in range(1, 5)}
    worker = FakeWorker(files)
    r = Runner(load_settings("local"), worker, worker_id="test")  # type: ignore[arg-type]
    return r, worker


def test_load_then_transform_results_match_the_contracts(runner):
    r, worker = runner
    assert r.process(job("load")) == "succeeded"
    _, load = worker.results[-1]
    c.LoadResult.model_validate_json(json.dumps(load))
    assert (load["rows_read"], load["rows_inserted"], load["unique_new_events"]) == (10_000, 10_000, 10_000)
    assert load["lake"]["snapshots_read"] == 1 and not load["lake"]["fallback_full_scan"]  # first load: full read
    assert load["lake"]["landing_through"] == f"{PREFIX}r0000000004.ndjson"  # the committer's cursor
    assert load["raw_max_load_seq"] == 1_790_000_000_000_001

    assert r.process(job("transform")) == "succeeded"
    _, transform = worker.results[-1]
    c.TransformResult.model_validate_json(json.dumps(transform))
    assert transform["dbt"]["success"] and transform["dbt"]["tests_error"] == 0
    assert set(transform["digests"]) == set(c.PUBLISHED_MODELS)
    assert transform["checks"]["warn"]["recon_metrics_vs_oracle"] == 0  # warn bucket by manifest severity
    assert transform["checks"]["error"]["recon_history_contiguity"] == 0
    assert transform["transformed_through_seq"] == 1_790_000_000_000_001
    assert sum(n for _, n in transform["ops_freshness_histogram_10s"]) == 10_000
    artifact = json.loads(worker.artifacts["r-test-000001"])
    assert len(artifact["rows"]) == transform["metrics_artifact"]["rows"] == 468
    # The snapshot viewers get is suppressed like the reporting views: no shown department cell has fewer
    # than 5 offer decisions, and no month hides exactly one department cell while showing ALL (ALL minus
    # the shown departments would give it back).
    rows = artifact["rows"]
    assert artifact["suppressed_by"] == "rpt_metrics_monthly"
    shown = [r for r in rows if r["offers_accepted"] is not None]
    assert all(int(r["offers_accepted"]) + int(r["offers_declined"]) >= 5 for r in shown)
    hidden = Counter(r["month"] for r in rows if r["department_id"] != "ALL" and r["offers_accepted"] is None)
    all_shown = {r["month"] for r in rows if r["department_id"] == "ALL" and r["offers_accepted"] is not None}
    assert hidden and not [m for m, n in hidden.items() if n == 1 and m in all_shown]

    # A second load from the same watermark inserts nothing (idempotent): deliveries dedupe on delivery_id.
    assert r.process(job("load", attempt=2)) == "succeeded"
    _, again = worker.results[-1]
    assert (again["rows_read"], again["rows_inserted"], again["duplicate_deliveries_skipped"]) == (10_000, 0, 10_000)


def test_eval_faults(runner):
    r, worker = runner
    assert r.process(job("load", faults=[{"run_seq": 1, "kind": "skip_claim"}])) == "skipped"
    assert worker.results == []
    assert r.process(job("load", faults=[{"run_seq": 1, "kind": "crash_after_load"}])) == "crashed"
    assert worker.results == []  # loaded but never reported
    assert r.process(job("load", attempt=2, faults=[{"run_seq": 1, "kind": "duplicate_result"}])) == "succeeded"
    assert [j for j, _ in worker.results] == ["r-test-000001-load-a2", "r-test-000001-load-a2"]
    failed = r.process(
        job("transform", faults=[{"run_seq": 1, "kind": "fail_transform_model", "model": "fct_workforce_monthly"}])
    )
    assert failed == "failed"
    _, result = worker.results[-1]
    TypeAdapter(c.FailedResult).validate_json(json.dumps(result))
    assert "fct_workforce_monthly" in result["error"]
    assert r.process(job("transform", attempt=2)) == "succeeded"


def test_recommit_fault_reappends_files(runner):
    r, worker = runner
    assert r.process(job("load")) == "succeeded"
    first_to = worker.results[-1][1]["lake"]["to_snapshot"]
    out = r.process(
        job(
            "load",
            attempt=2,
            from_snapshot=first_to,
            faults=[{"run_seq": 1, "kind": "recommit_sink_files", "count": 3}],
        )
    )
    assert out == "succeeded"
    _, load = worker.results[-1]
    assert load["lake"]["snapshots_read"] == 3
    assert (load["rows_read"], load["rows_inserted"]) == (7500, 0)


def test_worker_client_pages_runs_forward_from_since():
    from peoplelake.runner.client import WorkerClient

    runs = [{"run_id": f"r-{i}", "seq": i, "started_at": 1000 + i} for i in range(1, 451)]
    seen = []

    class Paging(WorkerClient):
        def __init__(self):
            pass

        def runs(self, limit=200, fmt="full", since=None):
            seen.append(since)
            return [r for r in runs if r["started_at"] >= (since or 0)][:200]

    out = Paging().all_runs("summary", since=0)
    assert [r["seq"] for r in out] == list(range(1, 451))
    assert seen == [0, 1200, 1399]  # the third page is short, so paging stops
