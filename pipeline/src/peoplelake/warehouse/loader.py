"""Load job (SPEC 10.2, 29.4.1): commit new landing rolls to the Iceberg table (every environment), read
appended data from the watermark to the current snapshot, load deliveries idempotently, report counts, the
landing cursor and the freshness histogram of new events."""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..lake.committer import LANDING_PREFIX, CommitReport, LandingSource, commit_pending, landing_cursor
from ..lake.reader import current_snapshot_id, read_appends
from .base import Warehouse


@dataclass
class LoadOutcome:
    result: dict
    commit: CommitReport | None


def run_load(
    job: dict,
    *,
    table,
    warehouse: Warehouse,
    landing: LandingSource | None,
    recommit: int = 0,
) -> LoadOutcome:
    started = time.monotonic()
    inp = job["input"]
    commit = None
    if landing is not None:
        table, commit = commit_pending(
            landing, table, prefix=inp.get("landing_prefix") or LANDING_PREFIX, recommit=recommit
        )
        table.refresh()
    from_snapshot = int(inp["from_snapshot"]) if inp.get("from_snapshot") else None
    to_snapshot = int(inp["to_snapshot"]) if inp.get("to_snapshot") else current_snapshot_id(table)
    batch = read_appends(table, from_snapshot, to_snapshot)
    warehouse.ensure_raw()
    stats = warehouse.load_deliveries(
        batch.table,
        run_id=job["run_id"],
        job_id=job["job_id"],
        load_seq=job["load_seq"],
        snapshot_ids=batch.snapshot_ids,
    )
    result = {
        "job_id": job["job_id"],
        "run_id": job["run_id"],
        "attempt": job["attempt"],
        "status": "succeeded",
        "lake": {
            "table": "peoplelake.raw_events",
            "from_snapshot": inp.get("from_snapshot"),
            "to_snapshot": str(to_snapshot) if to_snapshot is not None else None,
            "snapshots_read": batch.info.snapshots_read,
            "fallback_full_scan": batch.info.fallback_full_scan,
            "landing_through": landing_cursor(table, to_snapshot) if to_snapshot is not None else None,
        },
        "rows_read": stats.rows_read,
        "rows_inserted": stats.rows_inserted,
        "duplicate_deliveries_skipped": stats.duplicate_deliveries_skipped,
        "unique_new_events": stats.unique_new_events,
        "raw_max_load_seq": stats.raw_max_load_seq,
        "min_effective_date_new": stats.min_effective_date_new,
        "received_histogram_10s": [[b, n] for b, n in stats.received_histogram_10s],
        "warehouse": warehouse.kind,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    if stats.bytes_billed is not None:
        result["bytes_billed"] = stats.bytes_billed
    return LoadOutcome(result=result, commit=commit)
