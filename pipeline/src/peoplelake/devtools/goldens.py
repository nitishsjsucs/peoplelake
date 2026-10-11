"""Committed cross-language goldens derived from the contract fixtures."""

from __future__ import annotations

import json
from pathlib import Path

from ..normalize import raw_record
from ..paths import repo_root

CONTEXT = {
    "received_at": "2026-10-10T12:00:00.123Z",
    "ingest_request_id": "11111111-2222-4333-8444-555555555555",
    "producer": "peoplelake-ingest/0.1.0",
}
BATCH_KEYS = {"hris": "events", "ats": "records", "talent": "items"}


def delivery_id(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def raw_records_golden(root: Path | None = None) -> dict:
    root = root or repo_root()
    cases = []
    n = 0
    for source, key in BATCH_KEYS.items():
        batch = json.loads((root / "contracts" / "fixtures" / f"source-{source}.valid.json").read_text())
        for env in batch[key]:
            n += 1
            rec = raw_record(source, env, delivery_id=delivery_id(n), **CONTEXT)
            cases.append({"source": source, "envelope": env, "raw_record": rec})
    return {
        "description": "RawRecords produced from the valid source fixtures; asserted by vitest (normalize.ts) and pytest (normalize.py).",
        "context": CONTEXT,
        "cases": cases,
    }


def render_raw_records_golden() -> str:
    return json.dumps(raw_records_golden(), indent=2, ensure_ascii=True) + "\n"
