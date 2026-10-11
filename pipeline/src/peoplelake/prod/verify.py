"""`peoplelake prod verify` (SPEC 20.5): after `prod:e2e`, production must hold exactly 100,000 unique
events in BigQuery, R7 must be 0 at error level (catching records Basin accepted and then dropped), and
the BigQuery digests must equal the local full-profile reference digests."""

from __future__ import annotations

import json
from pathlib import Path

from ..paths import data_dir
from .bootstrap_gcp import GcpConfig

EXPECTED_EVENTS = 100_000


def verify(config: GcpConfig, reference_path: Path | None = None) -> dict:
    from google.cloud import bigquery

    from ..warehouse.bigquery_wh import BigQueryWarehouse

    bq = bigquery.Client(project=config.project, location=config.bq_location)
    p = config.project
    unique = list(bq.query(f"SELECT COUNT(DISTINCT event_id) AS n FROM `{p}.pl_staging.stg_events`").result())[0]["n"]
    r7 = list(
        bq.query(f"""
        WITH actual AS (SELECT source, event_type, COUNT(*) AS n FROM `{p}.pl_staging.stg_events` GROUP BY source, event_type),
        expected AS (SELECT source, event_type, expected_count FROM `{p}.pl_ops.expected_event_counts` WHERE profile = 'full')
        SELECT COUNT(*) AS bad FROM actual a FULL OUTER JOIN expected e USING (source, event_type)
        WHERE a.n IS NULL OR e.expected_count IS NULL OR a.n != e.expected_count
    """).result()
    )[0]["bad"]
    reference_path = reference_path or data_dir() / "reference" / "reference-digests-full.json"
    reference = json.loads(reference_path.read_text())["digests"] if reference_path.exists() else None
    digests = BigQueryWarehouse(bq, p, location=config.bq_location).digests()
    mismatched = sorted(m for m in (reference or {}) if digests.get(m) != reference[m]) if reference else None
    result = {
        "unique_events": int(unique),
        "unique_events_ok": int(unique) == EXPECTED_EVENTS,
        "r7_mismatched_rows": int(r7),
        "basin_dropped_records": "could not check (the analytics dataset name is unverified)",
        "digests": digests,
        "reference": str(reference_path)
        if reference
        else "missing: run `peoplelake dev reference-digests --profile full`",
        "digests_mismatched": mismatched,
    }
    result["passed"] = result["unique_events_ok"] and int(r7) == 0 and mismatched == []
    return result
