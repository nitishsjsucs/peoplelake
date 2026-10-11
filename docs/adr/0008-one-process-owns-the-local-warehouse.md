# ADR 0008: One process owns the local warehouse file

Status: accepted (2026-10-10)

## Context
DuckDB allows one read-write process per file, and a second process cannot open it even read-only while the first holds it. In-process dbt keeps the file open for the life of the process, and DuckDB refuses a second in-process connection with a different configuration.

## Decision
While the local stack is up, the runner process is the only process that touches `.data/.../peoplelake.duckdb`. It loads, runs dbt in process (`dbtRunner`), computes digests and freshness histograms, and returns them in its job results. Every connection uses `open_duckdb` (default configuration, read-write, `SET TimeZone='UTC'`). Evals and `peoplelake digest` open the file only after `peoplelake stack down`.

## Consequences
Evals read digests, checks and freshness from the Coordinator ledger while the stack runs, and verify the file after it stops.
