"""Incremental reads of appended lake data (SPEC 9.2).

Normal path: every APPEND snapshot after the watermark up to the target snapshot, scanned one at a time
so each row keeps the id of the snapshot that added it (compaction `replace` snapshots are skipped).
Replays (no watermark) and expired watermarks read the full table as of the target snapshot instead
(`fallback_full_scan`); the MERGE on delivery_id keeps that idempotent.
"""

from __future__ import annotations

from dataclasses import dataclass

import pyarrow as pa
from pyiceberg.table import Table
from pyiceberg.table.snapshots import Operation, ancestors_between_ids

from .schema import RAW_ARROW_SCHEMA, to_canonical


@dataclass
class ReadInfo:
    from_snapshot: str | None
    to_snapshot: str | None
    snapshots_read: int
    fallback_full_scan: bool
    rows: int


@dataclass
class LakeBatch:
    table: pa.Table
    snapshot_ids: list[str | None]
    info: ReadInfo


def current_snapshot_id(table: Table) -> int | None:
    snap = table.current_snapshot()
    return None if snap is None else snap.snapshot_id


def _empty(from_snapshot: int | None, to_snapshot: int | None) -> LakeBatch:
    info = ReadInfo(
        str(from_snapshot) if from_snapshot else None, str(to_snapshot) if to_snapshot else None, 0, False, 0
    )
    return LakeBatch(RAW_ARROW_SCHEMA.empty_table(), [], info)


def read_appends(table: Table, from_exclusive: int | None, to_inclusive: int | None = None) -> LakeBatch:
    meta = table.metadata
    to_id = to_inclusive if to_inclusive is not None else current_snapshot_id(table)
    if to_id is None:
        return _empty(from_exclusive, None)
    if from_exclusive == to_id:
        return _empty(from_exclusive, to_id)
    if from_exclusive is None or meta.snapshot_by_id(from_exclusive) is None:
        data = to_canonical(table.scan(snapshot_id=to_id).to_arrow())
        info = ReadInfo(str(from_exclusive) if from_exclusive is not None else None, str(to_id), 1, True, data.num_rows)
        return LakeBatch(data, [f"full-scan@{to_id}"] * data.num_rows, info)

    appends = [
        s
        for s in ancestors_between_ids(
            from_snapshot_id_exclusive=from_exclusive, to_snapshot_id_inclusive=to_id, table_metadata=meta
        )
        if s.summary is not None and s.summary.operation == Operation.APPEND
    ]
    appends.sort(key=lambda s: s.sequence_number)
    parts: list[pa.Table] = []
    snapshot_ids: list[str | None] = []
    for snap in appends:
        part = table.incremental_append_scan(
            from_snapshot_id_exclusive=snap.parent_snapshot_id, to_snapshot_id_inclusive=snap.snapshot_id
        ).to_arrow()
        part = to_canonical(part)
        parts.append(part)
        snapshot_ids += [str(snap.snapshot_id)] * part.num_rows
    data = pa.concat_tables(parts) if parts else RAW_ARROW_SCHEMA.empty_table()
    info = ReadInfo(str(from_exclusive), str(to_id), len(appends), False, data.num_rows)
    return LakeBatch(data, snapshot_ids, info)
