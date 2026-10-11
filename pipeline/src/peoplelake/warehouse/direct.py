"""Load generated source data straight into a warehouse, bypassing the Worker and the lake.

Used by the dbt CI job, the reference digests and dbt-level tests. Deliveries get deterministic ids
(`uuid5(direct/<event_id>)`), so loading the same events twice inserts nothing the second time.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from pathlib import Path

import pyarrow as pa

from .. import __version__
from ..generator import SOURCES, Dataset
from ..normalize import raw_record, records_to_arrow
from .base import LoadStats
from .duckdb_wh import DuckDBWarehouse

NAMESPACE_DIRECT = uuid.UUID("0c8a3f57-91d2-4b6e-a5f4-2d7e9b1c3a60")
UPDATED_FIELD = {"hris": "recordedAt", "ats": "occurred_at", "talent": "updated"}
SEQUENCE_FIELD = {"hris": "sequence", "ats": "seq", "talent": "revision"}


def envelopes_from_dir(path: Path) -> dict[str, list[dict]]:
    return {s: [json.loads(line) for line in (path / f"{s}.jsonl").read_text().splitlines()] for s in SOURCES}


def envelopes_from_dataset(ds: Dataset) -> dict[str, list[dict]]:
    return {s: ds.envelopes(s) for s in SOURCES}


def canonical_order(envelopes: dict[str, list[dict]]) -> list[tuple[str, dict]]:
    """All events of all sources in recorded order (ties: source order, then source sequence)."""
    items = [(s, e) for s in SOURCES for e in envelopes[s]]
    rank = {s: i for i, s in enumerate(SOURCES)}
    items.sort(key=lambda it: (it[1][UPDATED_FIELD[it[0]]], rank[it[0]], it[1][SEQUENCE_FIELD[it[0]]]))
    return items


def part(items: list, index: int, parts: int) -> list:
    """The index-th of `parts` contiguous slices (1-based)."""
    n = len(items)
    return items[(index - 1) * n // parts : index * n // parts]


def direct_table(items: list[tuple[str, dict]], received_at: str = "2026-10-01T00:00:00Z") -> pa.Table:
    def records() -> Iterator[dict]:
        for source, env in items:
            event_id = env[{"hris": "eventId", "ats": "id", "talent": "uuid"}[source]]
            yield raw_record(
                source,
                env,
                received_at=received_at,
                delivery_id=str(uuid.uuid5(NAMESPACE_DIRECT, f"direct/{event_id}")),
                ingest_request_id="direct-load",
                producer=f"peoplelake-direct/{__version__}",
            )

    return records_to_arrow(records())


def load_direct(wh: DuckDBWarehouse, items: list[tuple[str, dict]], *, load_seq: int | None = None) -> LoadStats:
    wh.ensure_raw()
    if load_seq is None:
        current = (
            wh.query_arrow("SELECT max(_pl_load_seq) AS m FROM pl_raw.raw_event_deliveries").column("m")[0].as_py()
        )
        load_seq = (current or 0) + 1
    table = direct_table(items)
    return wh.load_deliveries(
        table, run_id="direct", job_id=f"direct-{load_seq}", load_seq=load_seq, snapshot_ids=["direct"] * table.num_rows
    )
