"""Load and transform jobs, plus eval fault hooks (SPEC 8.4, 10.2)."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..canonical import canonical_json
from ..paths import warehouse_dir
from ..warehouse.dbt_runner import DbtRunner
from ..warehouse.digest import DIGEST_VERSION, SNAPSHOT_SPEC, canon


class SimulatedCrash(RuntimeError):
    """Eval fault: the process 'dies' after doing the work, so no result is reported."""


@dataclass
class Faults:
    crash_after_load: bool = False
    fail_model: str | None = None
    duplicate_result: bool = False
    skip_claim: bool = False
    recommit: int = 0
    fired: list[str] = field(default_factory=list)

    @classmethod
    def from_job(cls, job: dict) -> Faults:
        f = cls()
        for spec in job.get("faults") or []:
            kind = spec["kind"]
            if kind == "crash_after_load":
                f.crash_after_load = True
            elif kind == "fail_transform_model":
                f.fail_model = spec.get("model") or "fct_workforce_monthly"
            elif kind == "duplicate_result":
                f.duplicate_result = True
            elif kind == "skip_claim":
                f.skip_claim = True
            elif kind == "recommit_sink_files":
                f.recommit = int(spec.get("count") or 1)
        return f


def seed_checksum(seeds_dir: Path | None = None) -> str:
    seeds_dir = seeds_dir or warehouse_dir() / "seeds"
    h = hashlib.sha256()
    for path in sorted(seeds_dir.rglob("*.csv")):
        h.update(str(path.relative_to(seeds_dir)).encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def metrics_artifact_body(run_id: str, warehouse, profile: str, suffix: str | None = None) -> tuple[str, int]:
    """The committed metrics snapshot (served to viewers by /api/metrics/latest and /api/ask): the mart's
    rows and columns read through rpt_metrics_monthly, so every cell the reporting views suppress is null
    here too. The output digests are computed from the mart itself, separately."""
    spec = SNAPSHOT_SPEC
    table = warehouse.fetch_model(spec, suffix)
    rows = []
    for values in zip(*(table.column(c).to_pylist() for c in spec.column_names), strict=True):
        rows.append({c: canon(v, logical) for v, (c, logical) in zip(values, spec.columns, strict=True)})
    rows.sort(key=lambda r: (r["month"], r["department_id"]))
    body = canonical_json(
        {
            "run_id": run_id,
            "engine": warehouse.kind,
            "profile": profile,
            "model": "metrics_workforce_monthly",
            "suppressed_by": spec.name,
            "digest_version": DIGEST_VERSION,
            "rows": rows,
        }
    )
    return body, len(rows)


def run_transform(job: dict, *, warehouse, dbt: DbtRunner, upload, profile: str, faults: Faults) -> dict:
    """dbt seed (if seeds changed or replay), dbt build without unit tests, checks, digests, freshness
    histogram and the metrics artifact (uploaded through `upload(run_id, body) -> {key, sha256}`)."""
    started = time.monotonic()
    replay = bool(job["input"].get("full_refresh"))
    # BigQuery datasets carry the suffix; a local suffixed replay uses its own DuckDB file instead.
    suffix = job["input"].get("dataset_suffix") if warehouse.kind == "bigquery" else None
    checksum = seed_checksum()
    if replay or warehouse.seed_checksum() != checksum:
        seeded = dbt.seed(full_refresh=True)
        if not seeded.success:
            return _failed(job, started, f"dbt seed failed: {seeded.failed_nodes or seeded.exception}")
        warehouse.set_seed_checksum(checksum)
    before = warehouse.max_load_seq("peoplelake_ops", "ops_event_freshness")
    if faults.fail_model:
        faults.fired.append(f"fail_transform_model:{faults.fail_model}")
    outcome = dbt.build(full_refresh=replay, fail_model=faults.fail_model)
    if not outcome.success:
        detail = ", ".join(n.split(".")[-1] for n in outcome.failed_nodes[:10]) or (outcome.exception or "unknown")
        return _failed(
            job, started, f"dbt build failed ({outcome.models_error} models, {outcome.tests_error} tests): {detail}"
        )
    digests = warehouse.digests(suffix)
    histogram = warehouse.freshness_histogram(-1 if before is None or replay else before)
    body, rows = metrics_artifact_body(job["run_id"], warehouse, profile, suffix)
    uploaded = upload(job["run_id"], body)
    dbt_stats = {
        "success": True,
        "models_ok": outcome.models_ok,
        "models_error": outcome.models_error,
        "tests_pass": outcome.tests_pass,
        "tests_warn": outcome.tests_warn,
        "tests_error": outcome.tests_error,
        "elapsed_ms": outcome.elapsed_ms,
    }
    if warehouse.kind == "bigquery":
        dbt_stats["bytes_billed"] = outcome.bytes_billed
    return {
        "job_id": job["job_id"],
        "run_id": job["run_id"],
        "attempt": job["attempt"],
        "status": "succeeded",
        "dbt": dbt_stats,
        "checks": {
            "error": {k: v for k, v in outcome.checks_error.items() if k.startswith("recon_")},
            "warn": {k: v for k, v in outcome.checks_warn.items() if k.startswith("recon_")},
        },
        "digests": digests,
        "digest_version": DIGEST_VERSION,
        "engine": warehouse.kind,
        "transformed_through_seq": max(0, warehouse.max_load_seq("peoplelake_staging", "stg_events") or 0),
        "ops_freshness_histogram_10s": [[b, n] for b, n in histogram],
        "metrics_artifact": {"key": uploaded["key"], "sha256": uploaded["sha256"], "rows": rows},
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


def _failed(job: dict, started: float, error: str) -> dict:
    return {
        "job_id": job["job_id"],
        "run_id": job["run_id"],
        "attempt": job["attempt"],
        "status": "failed",
        "error": error[:2000],
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


def failed_result(job: dict, error: str, started: float | None = None) -> dict:
    return _failed(job, started if started is not None else time.monotonic(), error)
