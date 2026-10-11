"""Reference digests (SPEC 15.4): a straight load of a profile into DuckDB, built incrementally on an empty
warehouse (with unit tests) and then with --full-refresh; both digest sets must be equal. Every scenario
leg is compared with these digests.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from pathlib import Path

from ..generator import generate, get_profile
from ..warehouse.dbt_runner import DbtOutcome, DbtRunner
from ..warehouse.digest import DIGEST_VERSION
from ..warehouse.direct import canonical_order, envelopes_from_dataset, load_direct
from ..warehouse.duckdb_wh import DuckDBWarehouse


class ReferenceError_(RuntimeError):
    pass


def _require(outcome: DbtOutcome, step: str, *, no_warnings: bool = False) -> None:
    if not outcome.success:
        raise ReferenceError_(f"{step} failed: {outcome.failed_nodes or outcome.exception}")
    if no_warnings and outcome.tests_warn:
        raise ReferenceError_(f"{step}: warn-level checks at quiescence: {outcome.checks_warn}")


def reference_digests(profile: str, workdir: Path) -> dict:
    workdir.mkdir(parents=True, exist_ok=True)
    db = workdir / f"reference-{profile}.duckdb"
    wh = DuckDBWarehouse(db)
    wh.reset()
    os.environ["PL_DUCKDB_PATH"] = str(db)
    os.environ["PL_PROFILE"] = profile
    os.environ.pop("PL_DATASET_SUFFIX", None)
    started = time.monotonic()
    items = canonical_order(envelopes_from_dataset(generate(get_profile(profile))))
    stats = load_direct(wh, items)
    dbt = DbtRunner(target_path=workdir / "dbt-target")
    _require(dbt.seed(), "dbt seed")
    _require(dbt.run_empty(), "dbt run --empty")
    incremental = dbt.build(unit_tests=True)
    _require(incremental, "dbt build", no_warnings=True)
    digests_incremental = wh.digests()
    full = dbt.build(full_refresh=True)
    _require(full, "dbt build --full-refresh", no_warnings=True)
    digests_full = wh.digests()
    if digests_incremental != digests_full:
        diff = sorted(m for m in digests_full if digests_full[m] != digests_incremental.get(m))
        raise ReferenceError_(f"incremental and full-refresh digests differ for {diff}")
    return {
        "kind": "reference-digests",
        "profile": profile,
        "engine": "duckdb",
        "digest_version": DIGEST_VERSION,
        "digests": digests_full,
        "events_loaded": stats.rows_inserted,
        "dbt": {
            "tests_pass": incremental.tests_pass,
            "tests_warn": incremental.tests_warn,
            "tests_error": incremental.tests_error,
            "models_ok": incremental.models_ok,
        },
        "duration_s": round(time.monotonic() - started, 1),
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
