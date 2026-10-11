# Build progress

Builder log for the commit plan in SPEC.md section 23. Updated in every commit.

## Position
Commit 9 of 18 (core) done: Worker config and Access auth.

## Done
1. Scaffold: README, SPEC, CONTEXT, LICENSE, tsconfigs (worker, worker tests, node), `wrangler.jsonc` (vars only so far), generated `worker-configuration.d.ts`, `scripts/check-prose.ts`, vitest projects `worker` and `node`.

2. Generator: SplitMix64 PRNG, true world (`world.py`), three source emitters, canonical JSONL, manifest with dataset sha256 pinned for both profiles, oracle (468 rows per profile) and expected R6/R11 results (empty), committed seeds `warehouse/seeds/oracle/*` and `warehouse/seeds/reference/*`, CLI `peoplelake generate`.

3. Contracts: zod contracts in `src/shared/contracts.ts` (three source batches, RawRecord, JobSpec, LoadResult, TransformResult, FaultSpec) generate `contracts/*.schema.json` (`npm run contracts:gen`, checked by a node test); pydantic mirrors in `pipeline/src/peoplelake/contracts.py` with field-by-field schema tests; one valid and one invalid fixture per contract; canonical JSON in TS (`src/worker/ingest/canonical-json.ts`) and Python with a shared golden; every generated envelope (both profiles) validates under pydantic.

4. Warehouse: `open_duckdb` (default config, read-write, `SET TimeZone='UTC'`), `DuckDBWarehouse.load_deliveries` (batch dedupe by `delivery_id`, anti-join against `pl_raw.raw_event_deliveries`, stats incl. unique new events, 10 s histogram of first receipt of new events, `raw_max_load_seq`, `pl_ops.load_log`), digests by logical type with Python-side PK sort (`warehouse/digest.py`, 10 model specs), Python normalization mirror (`normalize.py`), direct loader and CLI `peoplelake warehouse load-direct`, `peoplelake digest`.

5. dbt core: `stg_events` (incremental merge, insert-only via anti-join, first delivery wins), six staging views, `int_hris__effective_events` (per-field latest correction, rescinds removed), `int_hris__spells`, `int_hris__attribute_timeline`, `dim_*`, `dim_employee_history` / `fct_workforce_monthly` / `fct_compensation_history` (bucketed, per-model cursors, pre-delete of affected buckets), `fct_employment_events`, `fct_offers`, `fct_performance_reviews`, `metrics_workforce_monthly`; 10 dbt unit tests; in-process `DbtRunner`; pytest: bucket cursor fault recovery, shuffled-delivery parity, empty-bucket regression, dbt session UTC, single owner with in-process dbt. Measured: metrics equal the oracle on all 468 rows for both profiles after a direct load.

6. Metrics and reconciliation: R1 to R11 as singular dbt tests plus an as-of consistency check, `ops_anomalies`, `ops_delivery_stats`, `ops_event_freshness`, reporting views with small-cell suppression, tamper tests proving each check fires, `peoplelake dev reference-digests`. Measured in this session: small profile 10,000 events, all dbt tests pass with 0 warnings, incremental equals full refresh (6.5 s); full profile 100,000 events, same result (10.3 s).

7. BigQuery: policy tags with `persist_docs` on restricted columns, authorized reporting views (`grant_access_to` on `pl_core`), offline compile of both branches (`peoplelake dev bq-compile`: 27 models and 94 tests parse as BigQuery with sqlglot), token-based ORDER BY NULLS lint (`peoplelake dev lint-sql`), manifest assertions, `BigQueryWarehouse` (Parquet load job to a stage table, stats, MERGE on `delivery_id`, load log, stage dropped even on failure) tested against a fake client. Nothing has run against BigQuery (no credentials on this machine).

8. Lake: `lake/catalog.py` (local `SqlCatalog` stand-in, Basin `RestCatalog`, `catalog_info` with the REST prefix), `lake/committer.py` (stand-in for Basin sink commits: one snapshot per `(key, etag)` sink file with `peoplelake.source-file/etag` properties, recommit fault), `lake/reader.py` (per-append-snapshot incremental reads keeping each row's snapshot id, replace and delete snapshots skipped, full-scan fallback for replays and expired watermarks), `infra/cloudflare/stream-schema.json`, `pipeline.sql`, `r2-notification.md`, `config.py` settings, CLI `peoplelake lake init|commit|scan|catalog-info`.

9. Worker auth: `parseConfig` (every rule in SPEC 7.2 plus `ACCESS_AUD=pending` only with runs disabled, placeholders refused, dev auth requires `DEV_ACCESS_JWKS`), `verifyAccessJwt` with jose (remote team JWKS in production, local JWKS for dev; header only, cookie ignored), principals from `common_name` / `email` through `ACCESS_ROLE_MAP`, `requireRole`, Hono app with `/v1/health` and `/v1/health/auth`; vitest generates ephemeral keys per run; Python `peoplelake auth dev-keys|dev-token` and `AccessHeaders` (dev JWT locally, service-token headers in production). Checked by hand in this session: PyJWT-minted dev tokens verify in `wrangler dev` on 127.0.0.1:8791 (runner and operator roles, 401 without a token); processes stopped and ports 8791 and 9241 free afterwards.

## Next
10. Ingest: three source envelopes, RawRecord normalization, Basin and local sinks (SinkRoller DO).

## Check status (last run at this commit)
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run typegen:check` | pass |
| `npm test` | pass (5 files, 68 tests) |
| `npm run check:prose` | pass |
| `npm run test:py` (pytest) | pass (178 tests) |
| `peoplelake dev bq-compile` | pass (both branches) |
| dbt unit tests (`dbt test --select test_type:unit` after `dbt run --empty`) | pass (10) |
| `ruff check` | pass |
| `peoplelake generate --profile small --check` | pass |

## Deviations from SPEC.md
- `tsconfig.worker-test.json` holds the worker test project's types (`@cloudflare/vitest-plugin/types`) so `tsconfig.worker.json` keeps `types: []` for source; `npm run typecheck` runs all three configs.
- Prose rules live in `scripts/lib/prose.ts` (pure function, unit tested); `scripts/check-prose.ts` is the CLI.
- `wrangler.jsonc` grows binding by binding as features land instead of declaring every binding in commit 1.
- Generator: extra modules `generator/records.py` (pre-sequencing record type), `generator/dataset.py` (sequencing and files), `generator/seeds.py` and `generator/pins.py`; `peoplelake/paths.py` finds the repo root (`PL_REPO_ROOT` overrides).
- Oracle seed columns: `fte` and `offer_acceptance_rate` are decimal strings with 6 places (empty rate when nobody decided). `ALL` rows carry `transfers_in = transfers_out = ` total transfers in the month. `expected_event_counts.csv` columns are `profile,source,event_type,expected_count`.
- `JobSpec`/`LoadResult`/`TransformResult`: failed and expired results share one smaller shape (`job_id, run_id, attempt, status, error, duration_ms?`) instead of the succeeded shape with optional fields; `FaultSpec` gains `attempt?` (S4 fails the transform on attempt 1 only); `TransformResult.digests` is a partial record (a verify step requires all 10).
- Load job orchestration (`loader.py` in the spec) lands with the lake reader and runner; commit 4 puts the load SQL in `DuckDBWarehouse.load_deliveries` and the Worker-free path in `warehouse/direct.py`.
- `received_histogram_10s` counts unique new events at their first `received_at` (what the freshness eval needs), not every inserted delivery.
- Digest model specs live in `warehouse/digest.py` with logical column types; values are canonicalized by logical type so DuckDB `HUGEINT`/`DECIMAL` and BigQuery `INT64`/`NUMERIC` agree.
- Bucketed models add a pre-hook (`pl_bucket_pre_delete`) that deletes every affected bucket before the replace. Found in this session: with shuffled delivery, an employee terminated before the first month end of the window leaves an affected bucket with zero new rows, and both `delete+insert` and `insert_overwrite` replace only buckets present in the new rows, so stale rows survived. `test_bucket_that_becomes_empty_is_cleared` fails without the hook.
- Corrections apply per field (latest correction that sets a field wins) rather than whole-record latest; identical for the generated data and still covered by `ut_two_corrections_latest_wins`.
- `fct_workforce_monthly` and the metrics read `int_hris__*` tables (full rebuilds) rather than `dim_employee_history`, so one bucketed model failing never leaves another reading stale history.
- R1 and R2 subtract inferred spell exits and R3 checks structure only, so error-level checks hold while late data is in flight (a rehire arriving before the prior termination); R11 reports those cases. A missing prior spell is an anomaly (warn), not an R3 error.
- Extra error-level check `recon_history_as_of_matches_snapshot` exercises `pl_employee_as_of` against `fct_workforce_monthly` at seven month ends.
- The BigQuery MERGE inserts an explicit column list instead of `INSERT ROW` (the stage carries `_pl_snapshot_id` and an ordering column, the target five `_pl_*` columns); `QUALIFY` is paired with `WHERE TRUE`.
- `read_appends` with no watermark (replay) reads the full table as of the target snapshot rather than an incremental scan from the oldest ancestor, so compaction rewrites can never hide data from a replay; it reports `fallback_full_scan: true`.
- The committer's `SinkSource` protocol has a directory implementation now; the Worker-backed source (`/internal/dev/sink/files`) lands with the runner.
- Correction events carry `effectiveDate` = the corrected date for date corrections and the target's date for value corrections; rescinds carry the target's date. The one-event-per-day rule is asserted on business events (hire, rehire, termination, transfer, job and FTE change) for both original and corrected dates.
