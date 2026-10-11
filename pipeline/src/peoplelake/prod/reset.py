"""`peoplelake prod reset --confirm peoplelake` (runbook docs/runbooks/prod-reset.md): empties the BigQuery
datasets and drops the Basin Catalog table so `npm run prod:e2e` can deliver the same 100,000 event ids
again. The Coordinator ledger is reset separately through `POST /api/ops/reset` (operator)."""

from __future__ import annotations

from .bootstrap_gcp import DATASETS, GcpConfig

CONFIRM = "peoplelake"


def reset(config: GcpConfig, confirm: str, *, drop_lake: bool = True) -> dict:
    if confirm != CONFIRM:
        raise SystemExit(f"refusing to reset production without --confirm {CONFIRM}")
    from google.cloud import bigquery

    bq = bigquery.Client(project=config.project, location=config.bq_location)
    dropped = []
    for name in DATASETS:
        for table in bq.list_tables(f"{config.project}.{name}"):
            bq.delete_table(table.reference, not_found_ok=True)
            dropped.append(f"{name}.{table.table_id}")
    lake = "skipped"
    if drop_lake:
        try:
            from ..config import load_settings
            from ..lake.catalog import TABLE_ID, basin_catalog

            s = load_settings("prod")
            basin_catalog(s.r2_catalog_uri or "", s.r2_warehouse or "", s.r2_catalog_token or "").drop_table(TABLE_ID)
            lake = "dropped peoplelake.raw_events (the sink recreates it on its next roll)"
        except Exception as exc:  # noqa: BLE001 - dropping a sink-created table is unverified (SPEC risk 16)
            lake = f"could not drop the Basin table ({type(exc).__name__}); follow docs/runbooks/prod-reset.md for a new table name"
    return {"bigquery_tables_dropped": len(dropped), "lake": lake}
