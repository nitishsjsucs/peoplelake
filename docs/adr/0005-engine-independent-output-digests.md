# ADR 0005: Engine-independent output digests

Status: accepted (2026-10-10)

## Decision
"Identical warehouse outputs" means equal SHA-256 digests over 10 published models (`dim_department`, `dim_job`, `dim_employee_history`, `dim_employee`, `fct_employment_events`, `fct_offers`, `fct_workforce_monthly`, `metrics_workforce_monthly`, `fct_compensation_history`, `fct_performance_reviews`). Each model declares its business columns with a logical type and its primary key; values are canonicalized by logical type (dates `YYYY-MM-DD`, timestamps ISO UTC with microseconds, exact decimals with 6 places, integers, booleans, null), rows are sorted by the key in Python and hashed as JSON lines. `_pl_*` metadata, `received_at` and `delivery_id` never reach a digest. SQL that feeds digests is engine-neutral: no floats, explicit `NULLS LAST` with total orders (enforced by a token-level lint), UTC sessions.

## Consequences
DuckDB and BigQuery outputs are comparable with each other; a pinned digest of a tiny fixture guards the canonicalization.
