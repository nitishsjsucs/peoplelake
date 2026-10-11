# ADR 0003: Local stand-ins are labeled stand-ins

Status: accepted (2026-10-10)

## Context
Miniflare's Pipeline binding accepts `send()` and discards the data, there is no local Basin Catalog, and BigQuery has no local emulator.

## Decision
Locally, the `SinkRoller` Durable Object buffers accepted records and writes NDJSON roll files to local R2 every 60 s (the Basin minimum roll interval) or at a record limit, and enqueues an R2-notification-shaped message per roll. A Python committer appends each `(key, etag)` file to a pyiceberg `SqlCatalog` table as one snapshot. DuckDB through dbt-duckdb stands in for BigQuery, a ticker process for the Workers cron, locally generated RS256 keys for the Access JWKS, and llama-server or a deterministic stub for Workers AI. Code, logs, results files and the README name every one of these as a stand-in.

## Consequences
The local path runs offline and in CI with the same Worker, Workflow, runner and dbt code as production. Claims about Basin Pipelines, Basin Catalog, BigQuery and production Workflows hold only after the production go-live steps.
