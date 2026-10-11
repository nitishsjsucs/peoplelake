# ADR 0001: Idempotency lives in the warehouse

Status: accepted (2026-10-10)

## Context
Sources retry requests, the lake can hand the loader the same data twice (a rewound watermark, a recommitted file, a full-scan fallback), and runner jobs can be retried after a crash. Basin sinks are exactly-once from stream to sink, which covers none of these.

## Decision
Every record carries the source's deterministic `event_id` and a Worker-minted `delivery_id` (one per record per request). The Worker does no request-level deduplication, so duplicates stay visible and countable. The loader inserts a delivery only if its `delivery_id` is absent (`INSERT ... WHERE NOT EXISTS` on DuckDB, `MERGE ... WHEN NOT MATCHED` on BigQuery) and deduplicates within a batch first. dbt staging (`stg_events`) is insert-only on `event_id`: the earliest delivery wins and a later duplicate never overwrites it or marks an employee bucket dirty. R8 checks that every delivery of an event carries the same payload.

## Consequences
Re-running any load or replaying the lake is harmless. `ops_delivery_stats` shows deliveries against unique events per source and type. Scenario S1 (111,000 deliveries of 100,000 events) and S2 (rewound watermarks and recommitted lake files) must produce the reference digests.
