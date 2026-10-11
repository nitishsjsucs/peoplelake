"""Envelope to RawRecord, the Python mirror of src/worker/ingest/normalize.ts.

Used to load generated data straight into a warehouse (dbt CI job, tests) and to cross-check the
Worker's normalization. Production records are always minted by the Worker.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

import pyarrow as pa

from .canonical import canonical_json
from .lake.schema import RAW_ARROW_SCHEMA, RAW_COLUMNS

# envelope field names per source: id, type, entity, sequence, updated, effective, version, payload
FIELDS: dict[str, tuple[str, str, str, str, str, str, str, str]] = {
    "hris": ("eventId", "eventType", "workerId", "sequence", "recordedAt", "effectiveDate", "schemaVersion", "data"),
    "ats": ("id", "type", "object", "seq", "occurred_at", "effective_on", "v", "attributes"),
    "talent": ("uuid", "kind", "subject", "revision", "updated", "asOf", "version", "body"),
}


def raw_record(
    source: str,
    envelope: dict[str, Any],
    *,
    received_at: str,
    delivery_id: str,
    ingest_request_id: str,
    producer: str,
) -> dict[str, Any]:
    f_id, f_type, f_entity, f_seq, f_upd, f_eff, f_ver, f_payload = FIELDS[source]
    entity = envelope[f_entity]
    payload = canonical_json(envelope[f_payload])
    return {
        "event_id": envelope[f_id],
        "source": source,
        "event_type": envelope[f_type],
        "entity_id": entity["id"] if source == "ats" else entity,
        "source_sequence": envelope[f_seq],
        "source_updated_at": envelope[f_upd],
        "effective_date": envelope[f_eff],
        "schema_version": envelope[f_ver],
        "payload": payload,
        "payload_sha256": hashlib.sha256(payload.encode("ascii")).hexdigest(),
        "received_at": received_at,
        "delivery_id": delivery_id,
        "ingest_request_id": ingest_request_id,
        "producer": producer,
    }


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def records_to_arrow(records: Iterable[dict[str, Any]]) -> pa.Table:
    rows = list(records)
    data: dict[str, list[Any]] = {c: [] for c in RAW_COLUMNS}
    for r in rows:
        for c in RAW_COLUMNS:
            v = r[c]
            if c in ("source_updated_at", "received_at"):
                v = parse_ts(v)
            data[c].append(v)
    return pa.Table.from_pydict(data, schema=RAW_ARROW_SCHEMA)
