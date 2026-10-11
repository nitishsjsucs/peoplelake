# Runbook: replay the warehouse from the lake

The Iceberg lake (Basin Catalog in production, the local SqlCatalog stand-in locally) is the source of truth. A replay rebuilds every warehouse model from it without touching the watermark logic of incremental runs.

## Full replay (production or local)
1. `curl -X POST https://peoplelake.<subdomain>.workers.dev/api/replay` with an operator identity (or `POST http://127.0.0.1:8791/api/replay` locally with `peoplelake auth dev-token operator`).
2. The Coordinator queues a `replay` run (single-flight; a pending replay wins over a pending incremental run).
3. The load job reads the whole table as of the current snapshot and MERGEs on `delivery_id` (idempotent); the transform runs `dbt seed` and `dbt build --full-refresh`.
4. Check `GET /api/runs?format=full`: the replay run must be `committed` with every error-level check 0; compare its digests with the previous committed run.

## The restricted tables in BigQuery
`fct_compensation_history` and `fct_performance_reviews` have `full_refresh: false` on BigQuery: `--full-refresh` leaves them to their incremental path (bucketed replace and merge on `review_id`, which equal a full rebuild over the same raw rows), so the policy-tagged tables are never recreated and their columns are never untagged. If one must be rebuilt from scratch (a changed model, a damaged table): drop the two analyst views first (`bq rm -f <project>:peoplelake_restricted_access.compensation_history` and `.performance_reviews`), then the table, then replay. dbt recreates the table, tags its columns, and only then recreates the views; the runner fails the run and drops the views again if any restricted column is left untagged.

## Point-in-time replay into a scratch dataset
`POST /api/replay` with `{"to_snapshot": "<snapshot id>", "dataset_suffix": "pit"}` replays the lake only up to that snapshot into a scratch warehouse (a separate DuckDB file locally, `peoplelake_*_pit` datasets in BigQuery, which must exist first). A scratch run records its digests but never moves the watermark or the published metrics. Scenario S5 uses this to prove that replaying up to run k's snapshot reproduces run k's recorded digests.

## When to replay
After deleting or restoring the warehouse, after a dbt model change that alters history, or when snapshot expiration removed the watermark snapshot (incremental loads already fall back to a full scan on their own).
