# Runbook: restore BigQuery tables (time travel)

Two recovery paths exist: replay from the lake (`replay.md`) and BigQuery time travel, described here.

Time travel windows (set by `peoplelake prod bootstrap-gcp`): 48 h on `peoplelake_raw`, `peoplelake_staging`, `peoplelake_ops`; 168 h on `peoplelake_core`, `peoplelake_restricted`, `peoplelake_reporting`. After time travel, BigQuery keeps deleted data 7 more days in fail-safe, recoverable only through Cloud Customer Care.

## Why SQL and not a copy job
A copy job (`bq cp table@<epoch_ms>`) does not copy partitioning information or policy tags. A copied `dim_employee_history`, `fct_workforce_monthly` or `fct_compensation_history` would be unpartitioned (unusable by the int64-range `insert_overwrite`) and would expose restricted columns without masking.

## Drill (required before relying on it)
```bash
uv run --project pipeline peoplelake prod drill-restore --as-of-ms <epoch ms> --expected <file with the run's digests>
```
For each published model it runs `CREATE OR REPLACE TABLE peoplelake_<x>_drill.<model> [PARTITION BY RANGE_BUCKET(employee_bucket, GENERATE_ARRAY(0, 2048, 1)) CLUSTER BY employee_id] AS SELECT * FROM pl_<x>.<model> FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(<ms>)`, copies the source columns' policy tags onto the restored table before anything reads it, then compares the restored digests with the digests the ledger recorded for the run committed at that time (`GET /api/runs/<run_id>`). `peoplelake_restricted_drill` grants nothing to `pl-analyst`.

## Real restore
Run the same statements with the production dataset as the target only after the drill passed for the same point in time, then run an incremental run (`POST /api/runs`) so later lake data is applied again.
