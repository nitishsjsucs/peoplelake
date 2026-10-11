# PeopleLake domain glossary

Single-context repo. Terms used in code, tests, docs and commit messages.

- **Source**: one of `hris`, `ats`, `talent`. Each posts its own envelope shape to `POST /v1/ingest/:source`. Names are generic on purpose; no vendor products are simulated.
- **Domain**: the four business areas the sources carry: HR (hris), recruiting (ats), compensation and performance (talent).
- **Event**: a source fact with a stable `event_id` (UUIDv5 from profile, source and source sequence).
- **Delivery**: one accepted copy of an event, with its own Worker-minted `delivery_id`. A client retry of the same event is a second delivery of one event.
- **Raw record**: the normalized delivery row (14 columns) that is identical in the stream, the lake and the warehouse raw table.
- **Sink file** (local only): an NDJSON roll file written by the `SinkRoller` Durable Object, the local stand-in for the Basin sink.
- **Snapshot**: an Iceberg snapshot of `peoplelake.raw_events`.
- **Watermark**: the last snapshot whose data a committed run published.
- **Run**: one `WarehouseRunWorkflow` instance, id `r-<generation base36>-<seq:06d>`.
- **Job**: a unit of runner work, `load` or `transform`.
- **Attempt**: a retry of a job; each attempt has its own Workflow event type (`load-result-a2`).
- **Spell**: one continuous employment period. A rehire starts spell 2 with the same `employee_id`.
- **Correction**: an HRIS `worker.event_corrected` event that replaces fields of a prior event. The latest correction by source sequence wins.
- **Rescind**: an HRIS `worker.event_rescinded` event that cancels a prior event (v1 only rescinds terminations).
- **Effective-dated history**: SCD2 rows valid from a business date, independent of when the data arrived.
- **Published model**: one of the 10 dbt models covered by output digests.
- **Output digest**: SHA-256 over canonicalized rows of a published model (digest version 1), engine independent.
- **Oracle**: expected metric values computed by the generator from the true world, never from events; committed as dbt seeds.
- **Scenario**: a perturbed delivery plan (S1 to S5) compared with the baseline B.
- **Freshness**: commit time of the run that published an event minus the Worker receive time of its first delivery.
- **Quiescence**: all deliveries done and no active or pending run.
- **Load sequence** (`_pl_load_seq`): the Coordinator's monotonic number for a run's load, stamped on raw rows.
- **Employee bucket**: `employee_id` number modulo 2048; the unit of replacement for effective-dated models.
- **Bucket cursor**: the max load sequence a bucketed model has consumed, read from the model's own relation.
- **Transform skip**: a run that loaded nothing new and commits without running dbt.
- **Drill dataset**: a `pl_*_drill` BigQuery dataset used for scenario drills and restores, never for production reads.
- **Generation**: the epoch second when the Coordinator's storage was initialized; it prefixes run ids and load sequences.
- **Stand-in**: a local component that imitates a production service (SinkRoller, local SQL catalog, DuckDB, ticker, stub LLM). Always labeled as such.
