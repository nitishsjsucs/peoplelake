# ADR 0004: Bucketed replace with per-model cursors

Status: accepted (2026-10-10), amended the same day (pre-delete of affected buckets)

## Context
Effective-dated models change when late or corrected events arrive, possibly years in the past. dbt-bigquery accepts only `merge`, `insert_overwrite` and `microbatch` strategies.

## Decision
`dim_employee_history`, `fct_workforce_monthly` and `fct_compensation_history` are rebuilt per employee bucket (`employee_id` number modulo 2048): BigQuery `insert_overwrite` on an int64 range partition `employee_bucket`, DuckDB `delete+insert` with `unique_key='employee_bucket'`. Each model computes its affected buckets from its own cursor, the maximum `_pl_load_seq` stamped on its own rows, so a model that failed in an earlier attempt catches up on the next one even though upstream models already advanced theirs. Incremental runs emit complete histories for every employee in an affected bucket.

Amendment: both strategies replace only the buckets present in the new rows. A bucket whose correct state became empty (an employee whose termination before the first month end of the window arrives late) kept stale rows; shuffled delivery reproduced this in `fct_workforce_monthly`. Every bucketed model therefore runs a pre-hook that deletes all affected buckets first. If the model then fails, those buckets still hold events above the cursor and are rebuilt on the next attempt.

## Consequences
Incremental builds equal full refreshes (checked by `test_bucket_cursors.py`, including shuffled delivery and an injected model failure, and by every scenario). 2,048 partitions stay under BigQuery's per-table partition limit.
