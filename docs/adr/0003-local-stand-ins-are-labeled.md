# ADR 0003: Local stand-ins are labeled stand-ins

Status: accepted (2026-10-10); amended by ADR 0009 (2026-10-10): the landing is no longer a stand-in.

## Context
There is no local Basin Catalog, BigQuery has no local emulator, Cloud Run Jobs and Cloudflare Access do not run on a laptop, and Workers AI needs the network. Revision 2 also stood in for Basin Pipelines, whose Miniflare binding accepts `send()` and discards the data; production no longer uses Basin Pipelines (it needs Workers Paid, ADR 0009).

## Decision
The landing is the same code in both environments: the `LandingRoller` Durable Object buffers each accepted request as one SQLite row and writes planned, immutable NDJSON rolls to R2 (Miniflare's R2 locally, the `peoplelake-lake` bucket in production) with one Queue message per roll, and the runner's committer appends new rolls to the Iceberg table. What stays a stand-in locally, and is labeled as one in code, logs, results files and the README: a pyiceberg `SqlCatalog` for Basin Catalog, DuckDB through dbt-duckdb for BigQuery, the `peoplelake runner poll` process for the Cloud Run Job, a ticker process for the Workers cron, locally generated RS256 keys for the Access JWKS, and llama-server or a deterministic stub for Workers AI.

## Consequences
The local path runs offline and in CI with the same Worker, landing, Workflow, runner, committer and dbt code as production, and the Workers Free plan guards run locally with wide values. Claims about Basin Catalog, BigQuery, Cloud Run, Access, Workers AI and production Workflows hold only after the production go-live steps.
