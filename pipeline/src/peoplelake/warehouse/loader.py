"""Load job (SPEC 10.2): (local only) commit sink files to the stand-in lake, read appended data from the
watermark to the current snapshot, load deliveries idempotently, report counts and the freshness
histogram of new events."""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..lake.committer import CommitReport, SinkSource, commit_pending
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
    sink: SinkSource | None,
    recommit: int = 0,
) -> LoadOutcome:
    started = time.monotonic()
    commit = commit_pending(sink, table, recommit=recommit) if sink is not None else None
    if commit is not None:
        table = table.refresh()
    inp = job["input"]
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
    return LoadOutcome(result=result, commit=commit)
