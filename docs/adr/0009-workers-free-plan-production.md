# ADR 0009: Production runs on the Cloudflare Workers Free plan

Status: accepted (2026-10-10). Amends ADR 0002 (identity names) and ADR 0003 (the landing is no longer a stand-in). Details, numbers and sources: SPEC section 29.

## Context
Nitish keeps the Cloudflare account on the Workers Free plan. Basin Pipelines (streams, sinks and pipelines), which revision 2 used to land data in the Iceberg lake, is Workers Paid only: creating one on this account fails with "This feature requires a Workers Paid plan [code: 1021]". Queues, Workflows, SQLite Durable Objects, R2, Basin Catalog, Workers AI, AI Gateway core features and Zero Trust Access all work on Free, but with small allowances: 10 ms of CPU per request, cron and Workflow step; 3,000 Workflow steps, 10,000 Queue operations, 100,000 Durable Object requests and rows written, 5 million rows read and 10,000 Workers AI neurons a day. These allowances are per account, and other Workers on the same machine draw on them.

Revision 2 also broke those limits in places that have nothing to do with Basin Pipelines: 500-event ingest requests measured 16 to 22 ms of CPU at p99, every ingest request wrote to the Coordinator, the cron polled the catalog every minute and would start a new run every minute after a failure, the Coordinator's per-minute queries scanned its whole history, and Workers AI calls had neither `max_tokens` nor a daily cap.

On Google Cloud, four repos share the project `master-magnet-444903-u4`. Every name must carry this repo's prefix, every grant must be scoped to a dataset or resource, and every query must be capped with `maximum_bytes_billed`, so that one repo can neither read another's data nor use up the shared free tiers.

## Decision
1. The LandingRoller Durable Object (the former local `SinkRoller` stand-in) is the production landing in both environments. An ingest request appends its records as one SQLite row with one RPC. Every 60 s the roller writes a planned, immutable roll `landing/raw_events/g<generation>/r<roll_seq>.ndjson` to R2 (a retried roll rewrites identical bytes under the same key) and sends one Queue message per roll as the run trigger.
2. The runner's load job commits new rolls to the Iceberg table `peoplelake.raw_events` in Basin Catalog with pyiceberg's `RestCatalog`, one snapshot per roll. Each snapshot summary records `peoplelake.landing-through`, and the committer appends only rolls after the newest recorded value, so snapshot expiration can never cause a re-append. The warehouse still merges on `delivery_id` (ADR 0001), so even a double append changes nothing downstream. Setup creates the table (`peoplelake lake init --target prod`); compaction stays off and snapshot expiration (free) stays on.
3. Ingest requests carry at most 50 events (measured warm p99 2.8 to 3.7 ms), the Worker prewarms its schemas at startup, and production sources post every 10 s, so a 100,000-event delivery makes at most 3,080 requests.
4. The Coordinator drops per-request writes, adds indexes and per-day row counters, and guards automatic runs with a 5-minute backstop cron (heartbeat off), a 240 s minimum interval, exponential failure backoff up to 6 h, 30 automatic runs a UTC day and a 274 GB monthly BigQuery guard.
5. Workers AI stays on `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with `max_tokens` 96 and a daily cap of 1,800 neurons. The Workers AI ask eval is resumable across UTC days, and its results name that model.
6. In the shared Google Cloud project, every resource name starts with `peoplelake`. The runner, analyst, dispatcher and a dedicated build identity get only resource-scoped grants; the only project-level roles are `roles/bigquery.jobUser` and `roles/logging.logWriter`, and neither reads data. Every query is capped at 1 GB and labeled `app=peoplelake`. Bootstrap refuses to run while billing is disabled.
7. This repo plans to use at most 20% of each account-wide Cloudflare allowance and 25% of each Google free tier, and `npm run budget -- --check` enforces those shares from the repo's constants.

## Alternatives rejected
- **Workers Paid with Basin Pipelines:** declined by the owner.
- **A Queue as the data path:** at 50 events per request, a delivery needs about 3,080 messages and 9,240 operations, 92% of the account's 10,000 a day. Free retention is 24 h, so a consumer outage of a day would lose accepted data. And 500-event requests would not fit the 128 KB message limit.
- **One R2 object per request without a sequencer:** about 3,080 small objects per delivery, written out of key order by concurrent requests, so the committer could not use a simple cursor.

## Consequences
Local and production run the same landing code, and the only lake stand-in left is the catalog (`SqlCatalog`). The runner needs an R2 Admin Read & Write token, which reaches every bucket on the account; it lives only in `.prod/secrets.env` and in a Secret Manager secret that only `peoplelake-runner` can read. Production freshness gains a possible wait of up to 240 s between automatic runs. Workflow instances are kept only 3 days, so the Coordinator ledger and the R2 run reports are the history. The resume phrase "Basin Pipelines" becomes untrue; the replacement wording is in SPEC section 0.1. The committed local results predate this design and must be recorded again.
