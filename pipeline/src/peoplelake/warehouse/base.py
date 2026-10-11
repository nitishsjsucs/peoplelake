"""Warehouse protocol shared by the DuckDB stand-in and BigQuery (SPEC 10.1)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

import pyarrow as pa

EngineKind = Literal["duckdb", "bigquery"]


@dataclass
class LoadStats:
    rows_read: int
    rows_inserted: int
    duplicate_deliveries_skipped: int
    unique_new_events: int
    raw_max_load_seq: int | None
    min_effective_date_new: str | None
    received_histogram_10s: list[tuple[int, int]] = field(default_factory=list)


class Warehouse(Protocol):
    kind: EngineKind

    def ensure_raw(self) -> None: ...

    def load_deliveries(
        self, batch: pa.Table, *, run_id: str, job_id: str, load_seq: int, snapshot_ids: list[str | None] | None = None
    ) -> LoadStats: ...

    def fetch_model(self, model: str) -> pa.Table: ...

    def reset(self) -> None: ...
