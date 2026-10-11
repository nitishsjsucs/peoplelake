"""Canonical Arrow schema of a raw record (SPEC 6.1), mirrored by infra/cloudflare/stream-schema.json."""

from __future__ import annotations

import pyarrow as pa

TS = pa.timestamp("us", tz="UTC")

RAW_FIELDS: tuple[tuple[str, pa.DataType], ...] = (
    ("event_id", pa.string()),
    ("source", pa.string()),
    ("event_type", pa.string()),
    ("entity_id", pa.string()),
    ("source_sequence", pa.int64()),
    ("source_updated_at", TS),
    ("effective_date", pa.string()),
    ("schema_version", pa.int32()),
    ("payload", pa.string()),
    ("payload_sha256", pa.string()),
    ("received_at", TS),
    ("delivery_id", pa.string()),
    ("ingest_request_id", pa.string()),
    ("producer", pa.string()),
)
RAW_COLUMNS: tuple[str, ...] = tuple(name for name, _ in RAW_FIELDS)
RAW_ARROW_SCHEMA = pa.schema([pa.field(name, typ, nullable=False) for name, typ in RAW_FIELDS])

# Columns the loader adds in the warehouse raw table.
WAREHOUSE_FIELDS: tuple[tuple[str, pa.DataType], ...] = (
    ("_pl_snapshot_id", pa.string()),
    ("_pl_load_run_id", pa.string()),
    ("_pl_load_job_id", pa.string()),
    ("_pl_loaded_at", TS),
    ("_pl_load_seq", pa.int64()),
)


def to_canonical(table: pa.Table) -> pa.Table:
    """Cast whatever physical types a catalog returns (timestamp unit and zone) to the canonical schema."""
    columns = []
    for name, typ in RAW_FIELDS:
        col = table.column(name)
        if pa.types.is_timestamp(typ) and pa.types.is_timestamp(col.type) and col.type.tz is None:
            col = col.cast(pa.timestamp(col.type.unit, tz="UTC"))
        columns.append(col.cast(typ))
    return pa.Table.from_arrays(columns, schema=RAW_ARROW_SCHEMA)
