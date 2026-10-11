# PeopleLake v1: Build Specification

- Spec date: 2026-10-10 (revision 2, same day: every blocking and important review finding resolved; see section 28)
- Repo: `~/Developer/projects/peoplelake`, published as `github.com/nitishsjsucs/peoplelake` (public, currently empty, no default branch yet)
- Status of this document: architect's spec. Nothing else exists in the repo yet. v1 is built from scratch; no earlier implementation is reused.
- Every version number, CLI flag and API shape below was checked on 2026-10-10 by `npm view`, PyPI JSON, scratch installs under `/private/tmp/.../scratchpad`, running the tools, or reading official docs. Section 25 is the verification log. Anything not verified is marked **[UNVERIFIED]** (or [U] in the setup tables).

---

## 0. Acceptance criteria (verbatim resume text)

```text
PeopleLake -- Workforce ELT and Historical Analytics Warehouse
Built a replayable workforce data platform that unified simulated HR, recruiting, compensation, and performance data using Cloudflare Workers, Basin Pipelines, and R2. Integrated BigQuery and dbt to support incremental processing, historical employee records, and consistent workforce reporting.
* Built Python/SQL ELT pipelines integrating three simulated enterprise sources and approximately 100,000 workforce events into BigQuery using Cloudflare Workers, Basin Pipelines, and R2.
* Built dbt dimensional models and effective-dated employee history supporting five workforce metrics, including headcount, FTE, hires, departures, and offer acceptance, with reconciliation checks for rehires and retroactive corrections.
* Built retry-safe orchestration with Cloudflare Workflows, targeting 15-minute p95 data freshness and identical warehouse outputs across five duplicate-delivery, late-arrival, and recovery scenarios.
```

Each phrase maps to code plus a test or eval (full map in section 15.6). Summary:

| Claim | Where it becomes true | Proof |
|---|---|---|
| replayable | lake is the source of truth; `replay` run rebuilds the warehouse from Iceberg | scenario S5 (full rebuild and point-in-time replay digests) |
| HR, recruiting, compensation, performance | 3 sources carrying 4 domains, all modeled | per-domain mart tests and manifest counts |
| Cloudflare Workers, Basin Pipelines, R2 | ingest Worker, Basin stream/pipeline/sink, R2 + Basin Catalog | production path (needs Nitish, section 20); local stand-ins clearly labeled |
| BigQuery and dbt, incremental | dbt-bigquery target, incremental models | offline BigQuery compile in CI; `prod:e2e`; scenarios on BigQuery `_drill` datasets (required go-live step); incremental vs full-refresh digest parity |
| three sources, ~100,000 events | generator emits exactly 100,000 unique events from `hris`, `ats`, `talent` | generator tests, `recon_event_counts_vs_manifest` |
| dimensional models, effective-dated history | star schema plus SCD2 `dim_employee_history` | dbt unit tests, contiguity tests |
| five metrics | headcount, FTE, hires, departures, offer acceptance rate | oracle tests against the generator's ground truth (committed oracle seeds) |
| reconciliation for rehires and retro corrections | dbt data tests R1 to R11 | dbt build in CI |
| retry-safe orchestration with Workflows | `WarehouseRunWorkflow` + Coordinator DO + attempt-scoped events + per-model bucket cursors | vitest Workflow introspection tests, scenario S4, dbt-level fault parity test |
| targeting 15-minute p95 freshness | measured, never assumed | `eval freshness` (local stack); production p95 computed once from the single live `prod:e2e` delivery |
| identical outputs across 5 scenarios | engine-independent output digests | `eval scenarios` on DuckDB (CI) and on BigQuery `_drill` datasets (go-live); each result row labels its engine |

## 1. Goals and non-goals

### Goals
1. Ingest three simulated enterprise sources (`hris`, `ats`, `talent`) through an authenticated Cloudflare Worker into an append-only Iceberg lake (Basin Pipelines into Basin Catalog on R2 in production).
2. Load the lake incrementally into a warehouse with Python, transform with dbt into a dimensional model with effective-dated employee history and five metrics, guarded by reconciliation checks.
3. Orchestrate every warehouse run with Cloudflare Workflows so any step can fail, retry or be re-delivered without changing outputs.
4. Prove idempotency (five scenarios, identical digests) and measure freshness (p95) with repeatable evals whose numbers come only from this repo's scripts.
5. Two honest paths: a local path that runs offline and in CI, and a production path (Cloudflare + Google Cloud: BigQuery and a Cloud Run Job runner) that runs as soon as Nitish provisions accounts, with an idempotent `npm run setup:prod` and an `npm run doctor`.

### Non-goals (v1)
- Real HR data or real vendor APIs. All data is synthetic; source names are generic (`hris`, `ats`, `talent`), never vendor product names.
- Atomic multi-table publish in BigQuery (dbt writes models in dependency order; consumers read the committed metrics snapshot). Recorded as a risk.
- Correction chains (a correction of a correction) in the generated data. The warehouse implements "latest correction by source_sequence wins" and unit-tests it, but the generator does not emit chains.
- Row-level security policies, OpenLineage emission (openlineage-dbt 1.53.0 installs; deferred), Looker/BI tooling, CDC from databases, streaming inserts into BigQuery, multi-region.
- GitHub Actions as production compute (ADR 0002). Actions run CI only.
- Below the core cut line (section 23): the 60-question ask eval, the React dashboard and the MetricFlow semantic layer. The Workers AI and AI Gateway slice (`AiProvider`, minimal `/api/ask`, setup and doctor checks) is above the cut. If the dashboard is not built, the README says plainly that v1 has no front end.

## 2. Architecture

### 2.1 Component diagram (production path, local stand-ins in brackets)

```mermaid
flowchart LR
  subgraph Sources["Simulated sources: peoplelake sim deliver"]
    H["hris"]
    A["ats"]
    T["talent"]
  end
  subgraph CF["Cloudflare"]
    ACC["Zero Trust Access<br/>service tokens and JWT"]
    W["Worker peoplelake<br/>Hono: /v1/ingest, /api, /internal"]
    S[("Basin Pipelines stream<br/>peoplelake_raw_stream<br/>(local stand-in: SinkRoller DO)")]
    P["Pipeline SQL and sink<br/>r2-data-catalog, roll 60 s"]
    L[("R2 peoplelake-lake<br/>Basin Catalog Iceberg table peoplelake.raw_events<br/>(local stand-in: pyiceberg SqlCatalog)")]
    Q[["Queue peoplelake-lake-events<br/>R2 notifications, optimization only<br/>(local: SinkRoller enqueues)"]]
    C["Coordinator DO<br/>ledger, jobs, single-flight"]
    WF["Workflow peoplelake-warehouse-run"]
    R2R[("R2 peoplelake-reports<br/>run reports, metrics snapshot")]
    AI["Workers AI via AI Gateway<br/>(local: llama-server or stub)"]
    CRON["Cron every minute<br/>polls Basin Catalog REST snapshot<br/>(local: ticker process)"]
  end
  subgraph GCP["Google Cloud US (local: DuckDB via dbt-duckdb)"]
    CR["Cloud Run Job peoplelake-runner<br/>Python runner + dbt, SA pl-runner<br/>(local: peoplelake runner poll)"]
    RAW[("BigQuery pl_raw.raw_event_deliveries")]
    DBT["dbt build: pl_staging, pl_core,<br/>pl_restricted, pl_reporting, pl_ops"]
  end
  H -->|"HTTPS + service token"| ACC
  A -->|"HTTPS + service token"| ACC
  T -->|"HTTPS + service token"| ACC
  ACC --> W
  W -->|"send records"| S
  S --> P
  P --> L
  L -.->|"object-create on metadata.json"| Q
  Q --> W
  CRON --> W
  W -->|"GET table metadata"| L
  W --> C
  C -->|"create instance"| WF
  WF -->|"jobs.run via Cloud Run Admin API"| CR
  CR -->|"claim, heartbeat, result"| W
  CR -->|"incremental append scan"| L
  CR -->|"load job + MERGE on delivery_id"| RAW
  RAW --> DBT
  CR -->|"dbt build in-process, digests, metrics artifact"| DBT
  WF -->|"commit"| C
  WF --> R2R
  W --> AI
```

### 2.2 Sequence: one warehouse run with a lost result and a retry

```mermaid
sequenceDiagram
  participant Cron as Cron (catalog poll) / lake event
  participant C as Coordinator DO
  participant WF as WarehouseRunWorkflow
  participant D as Dispatcher (Cloud Run or poll)
  participant R as Python runner
  participant Lake as Iceberg lake
  participant WH as Warehouse
  Cron->>C: requestRun(reason)
  C->>WF: get(id) else create(id=r-mgk3x2-000042, mode=incremental)
  WF->>C: step open-run (from_snapshot = last committed, load_seq)
  WF->>C: step dispatch:load:a1 (enqueue job)
  WF->>D: dispatch unless a runner was seen in the last 60 s
  R->>C: claim returns job load a1 (lease 600 s)
  R->>Lake: incremental_append_scan from watermark to current
  R->>WH: stage + MERGE on delivery_id, stamp _pl_load_seq
  Note over R: crash before reporting (fault)
  C-->>WF: lease expired, event load-result-a1 with status expired
  WF->>C: step dispatch:load:a2
  R->>C: claim returns job load a2
  R->>WH: same rows, 0 inserted (idempotent)
  R->>C: result load a2, event load-result-a2
  WF->>C: dispatch:transform:a1 (skipped if nothing new since the last transform)
  R->>WH: dbt build (no unit tests), per-model bucket cursors, digests
  R->>C: result transform a1 plus metrics artifact to R2
  WF->>WF: verify (error checks must be 0)
  WF->>C: commit sets watermark, transformed_through_seq, published_at
  WF->>C: release (start pending run if any)
```

### 2.3 Key design decisions (each becomes an ADR in `docs/adr/`)
1. **ADR 0001 Warehouse-level idempotency.** Every record carries a deterministic `event_id` (from the source) and a Worker-minted `delivery_id`. The loader MERGEs on `delivery_id`; dbt staging is insert-only on `event_id` (first delivery wins). No request-level dedupe in the Worker, so duplicates stay visible and countable. Basin sinks advertise exactly-once from stream to sink (verified in docs), which does not cover client retries or replays; hence warehouse-level idempotency.
2. **ADR 0002 Workflows orchestrate, a Cloud Run Job executes.** Workers cannot run dbt or pyiceberg. The Workflow owns sequencing, retries and commit; work is handed to a runner through attempt-scoped jobs and `step.waitForEvent`. Production runner: Cloud Run Job `peoplelake-runner` in `us-central1` (same cloud as BigQuery; attached service account `pl-runner`, so no keys for data access; instance-based billing with a 1-minute minimum per execution, inside the monthly free tier at this volume). The Worker starts an execution with `jobs.run` (no overrides) using a dispatch-only identity. GitHub-hosted Actions were rejected for production compute: GitHub's Additional Product Terms say Actions should not be used "as part of a serverless application", and GitHub-hosted runners should not be used for activity unrelated to the production, testing, deployment or publication of the repo's software. They also add cold-start queueing. Actions run CI only. Local runner: the same CLI in a polling loop.
3. **ADR 0003 Local stand-ins are labeled stand-ins.** Miniflare's Pipeline binding `send()` is a no-op (read in miniflare source), so locally a `SinkRoller` Durable Object writes NDJSON roll files to local R2 and a Python committer appends them to a pyiceberg `SqlCatalog` table. README and every log line name these as stand-ins.
4. **ADR 0004 Bucketed replace with per-model cursors.** Effective-dated models are rebuilt per affected employee bucket: BigQuery `insert_overwrite` on an int64 range partition `employee_bucket` (0..2047), DuckDB `delete+insert` with `unique_key='employee_bucket'`. dbt-bigquery rejects custom strategies (only `merge`, `insert_overwrite`, `microbatch`; read in its macro source), so this is the portable form. Each bucketed model computes its own affected buckets from its own cursor (`max(_pl_load_seq)` in `{{ this }}`), so a model that failed in an earlier attempt catches up on the next one (reproduced and fixed in scratch, section 28).
5. **ADR 0005 Engine-independent output digests.** "Identical warehouse outputs" means equal SHA-256 digests over 10 published models, computed in Python from canonicalized rows, so DuckDB and BigQuery outputs can also be compared to each other. SQL that feeds digests is written to be engine-neutral: no floats, explicit `NULLS LAST`, total orders, UTC sessions (section 11.8).
6. **ADR 0006 Verify the Access JWT on every request.** The Worker never trusts that Access ran; it verifies RS256, `iss`, `aud`, `exp` with jose against the team JWKS. Locally the same code verifies dev tokens signed by locally generated keys.
7. **ADR 0007 Metrics are checked against an oracle.** The generator keeps the true world state and emits expected metric values, committed as seeds; dbt tests compare the warehouse's five metrics to them exactly.
8. **ADR 0008 One process owns the local warehouse file.** DuckDB allows one read-write process per file, and a second process cannot even open it read-only while the first holds it (reproduced). In-process dbt keeps the file open for the life of the process (reproduced). The runner process is therefore the only process that touches `.data/warehouse/*.duckdb` while the stack is up; it returns digests, check counts and freshness histograms in its results. Evals and `peoplelake digest` open the file only after `stack down`.

## 3. Toolchain and pinned versions (verified 2026-10-10)

### 3.1 Node (exact pins in `package.json`, lockfile committed)
| Package | Version | Note |
|---|---|---|
| node | >=22.18 (local 25.9.0, CI 24 LTS "Krypton" 24.21.0) | wrangler 4.149 engines `>=22.0.0`; 22.18+ runs `.ts` scripts natively (strip-only mode: no enums, namespaces or parameter properties) |
| wrangler | 4.149.0 | latest on npm; has `pipelines`, `basin`, `r2 bucket catalog`, `r2 bucket notification`, `workflows`, `types --check --env-file`, `deploy --secrets-file`, `auth token` |
| @cloudflare/vitest-plugin | 1.4.0 | successor of `@cloudflare/vitest-pool-workers` (0.23.0 says "renamed"); peer `vitest ^4.1.0 \|\| ^5.0.0`; ships `./types` |
| vitest | 4.1.11 | vitest 5.0.3 exists; 4.1.11 pinned because sibling repos are proven on it |
| typescript | 6.0.3 | defaults changed: `types` is `[]` and `.ts` imports need `allowImportingTsExtensions` (both reproduced); TypeScript 7.0.2 (Go port) exists, not adopted |
| hono | 4.13.13 | |
| zod | 4.6.5 | request validation |
| jose | 6.2.12 | JWT verification, and RS256 signing of the GCP dispatcher assertion |
| jsonc-parser | 3.3.1 | `render-wrangler` script |
| @types/node | 24.19.1 | |
| Runtime types | generated by `wrangler types` into `worker-configuration.d.ts` (committed) | `@cloudflare/workers-types` 5.20261010.1 exists but is not needed |
| Below cut line | react 19.3.0, react-dom 19.3.0, vite 8.3.4, @vitejs/plugin-react 6.1.2, @types/react 19.3.0, happy-dom 20.14.5, @testing-library/react 16.3.3 | dashboard only |

TypeScript configs (all reproduced on TS 6.0.3):
- `tsconfig.node.json` (scripts and `src/shared`): `{strict, noEmit, module: "nodenext", target: "es2023", types: ["node"], allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true}`. `erasableSyntaxOnly` makes tsc reject what Node's strip-only mode would throw on at runtime (an enum fails with TS1294 in tsc and with an uncaught error under `node`). `src/shared` therefore uses `as const` unions, never enums.
- `tsconfig.worker.json`: `{strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, skipLibCheck, verbatimModuleSyntax, isolatedModules, module: "es2022", moduleResolution: "bundler", lib: ["es2023"], types: []}` with `include` listing `worker-configuration.d.ts`; the worker test project adds `types: ["@cloudflare/vitest-plugin/types"]`.

### 3.2 Python (`pipeline/pyproject.toml`, `requires-python = ">=3.12,<3.13"`, `uv.lock` committed, `[tool.uv] required-version = ">=0.12.17,<0.13"`)
| Package | Version | Note |
|---|---|---|
| python | 3.12.13 local, 3.12 in CI via setup-uv | pyarrow 26 requires >=3.11 |
| dbt-core | 1.12.5 | requires dbt-adapters >=1.24.5; one uv lock of 134 packages resolves with every pin below |
| dbt-duckdb | 1.11.0 | requires dbt-core >=1.8; ran `dbt build`, unit tests and in-process `dbtRunner` with core 1.12.5 in scratch |
| dbt-bigquery | 1.12.1 | requires dbt-core >=1.10; offline compile verified (section 11.9); profile fields `maximum_bytes_billed` and `impersonate_service_account` exist (read in its credentials class) |
| duckdb | 1.5.6 | session time zone defaults to the machine zone (reproduced); always set to UTC |
| pyarrow | 26.0.0 | |
| pyiceberg[sql-sqlite,pyarrow] | 0.12.0 | `SqlCatalog`, `RestCatalog`, `incremental_append_scan` verified |
| google-cloud-bigquery | 3.46.1 | rejects `max_time_travel_hours` outside 48..168 (verified); used to set it on datasets |
| google-cloud-datacatalog | 3.32.0 | `PolicyTagManagerClient.create_taxonomy/create_policy_tag/set_iam_policy` |
| google-cloud-bigquery-datapolicies | 0.10.1 | `DataMaskingPolicy.PredefinedExpression`: SHA256, ALWAYS_NULL, DEFAULT_MASKING_VALUE, LAST_FOUR_CHARACTERS, FIRST_FOUR_CHARACTERS, EMAIL_MASK, DATE_YEAR_MASK |
| httpx | 0.28.1 | runner to Worker |
| pyjwt[crypto] | 2.15.1 | dev token minting |
| pydantic | 2.14.0 | contracts |
| dev: pytest 9.1.1, ruff 0.17.0, sqlglot 30.22.0 | | sqlglot parses compiled BigQuery SQL offline and lints ORDER BY clauses |
| below cut line: dbt-metricflow[dbt-duckdb] 0.15.0 (requires dbt-core >=1.11,<1.13), metricflow 0.213.0 | | `mf query` verified against dbt-duckdb in scratch |

No dbt packages (`dbt deps` needs network). dbt's built-in cross-database macros (`dbt.date_trunc`, `dbt.datediff`, `dbt.dateadd`, `dbt.last_day`, `dbt.hash`) ship with dbt-adapters and compile for both engines (verified), but they return different types per engine, so the repo wraps them (section 11.8). `dbt.safe_cast` is a plain `cast` on dbt-duckdb (reproduced: it raises on bad input), so it is not used.

### 3.3 Other tools
- llama-server 0.5.0 (build 11146) at `/opt/homebrew/bin/llama-server`, model `~/Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf`. Started only as `llama-server -m <gguf> --host 127.0.0.1 --port 8150 -np 1 -c 8192 -ngl 99`. JSON-schema constrained output verified on 2026-10-10.
- gh 2.99.0 (installed). gcloud and bq are **not** installed (Nitish installs: `brew install --cask gcloud-cli`, cask version 587.0.0). Docker is not required on the Mac: the runner image is built by Cloud Build in production and by `docker build` in CI.
- GitHub Actions (CI only): `actions/checkout@v7`, `actions/setup-node@v7`, `astral-sh/setup-uv@v10.3.0` with `version: "0.12.17"` (the action otherwise installs the latest uv; it has no floating v10 tag), `actions/upload-artifact@v7`, `actions/download-artifact@v7`. Workflows declare `permissions: {contents: read}` and hold no cloud credentials.

### 3.4 Ports (shared machine, three other repos build in parallel)
- `wrangler dev --port 8791 --inspector-port 9241 --ip 127.0.0.1`
- `llama-server --port 8150 -np 1 -c 8192 -ngl 99`
- No other listeners. The Python runner, ticker and eval driver are clients only. Every process started by a script runs in its own process group and is killed (SIGTERM, then SIGKILL after 5 s) on exit; `peoplelake stack down` and the test teardown assert all three ports are free.

### 3.5 Time zone
Every process runs in UTC: `TZ=UTC` in npm scripts, `uv run` wrappers and CI `env`; `settings: {TimeZone: UTC}` in the dbt-duckdb profile; `SET TimeZone='UTC'` on every Python DuckDB connection. Reproduced on this Mac: `CAST(TIMESTAMPTZ '2026-01-01 03:00:00+00' AS DATE)` is 2025-12-31 under the default `America/Los_Angeles` session and 2026-01-01 under UTC (the CI and BigQuery answer). DuckDB views evaluate under the reader's session zone, so readers must set it too. Business dates stay typed `DATE`.

## 4. Exact file tree

```text
peoplelake/
  README.md                         # status, mermaid, local/prod setup, matrix, Results, "no front end" note unless the dashboard lands
  SPEC.md                           # this file
  CONTEXT.md                        # domain glossary (section 26)
  LICENSE                           # MIT
  .gitignore                        # node_modules, .wrangler, .data, .dev, .dev.vars, .prod, wrangler.production.jsonc, warehouse/target, warehouse/logs, web/dist
  .nvmrc                            # 24
  .python-version                   # 3.12
  .dev.vars.example                 # every secret name with an empty value: DEV_ACCESS_JWKS=, GCP_DISPATCHER_KEY=, R2_CATALOG_TOKEN=
  Dockerfile                        # runner image: python:3.12-slim + uv 0.12.17, `uv sync --locked --no-dev`, entrypoint `peoplelake`
  .dockerignore                     # also used as .gcloudignore source list
  package.json
  package-lock.json
  tsconfig.json                     # references the configs below
  tsconfig.worker.json              # section 3.1
  tsconfig.node.json                # section 3.1
  tsconfig.web.json                 # below cut line
  wrangler.jsonc                    # local config at top level (name peoplelake-local), env.production with __PL_*__ placeholders (section 7.1)
  worker-configuration.d.ts         # generated by `npm run typegen`, committed, checked in CI
  vitest.config.ts                  # projects: worker (cloudflareTest), node, web
  vite.config.ts                    # below cut line
  contracts/
    raw-record.schema.json
    source-hris.schema.json
    source-ats.schema.json
    source-talent.schema.json
    job.schema.json
    load-result.schema.json
    transform-result.schema.json
    fixtures/                       # one valid + one invalid example per schema; validated by both TS and Python tests
    golden/canonical-json.json      # payloads and their expected canonical bytes and sha256, asserted by vitest and pytest
  infra/
    cloudflare/
      stream-schema.json            # Basin structured stream schema (section 6.2)
      pipeline.sql                  # INSERT INTO peoplelake_raw_sink SELECT <explicit columns> FROM peoplelake_raw_stream;
      r2-notification.md            # rule definition and rationale (optimization only)
    gcp/
      README.md                     # what bootstrap-gcp creates
      cloudbuild.yaml               # docker build + push, options.logging CLOUD_LOGGING_ONLY
  scripts/
    render-wrangler.ts              # wrangler.jsonc + .prod/state.json -> wrangler.production.jsonc
    predeploy-check.ts              # refuses deploy if any __PL_ placeholder remains or prod vars are unsafe
    setup-prod.ts                   # idempotent provisioning (section 21)
    doctor.ts                       # prerequisite checks (section 21)
    check-prose.ts                  # fails on U+2014, U+2013, or " -- " in Markdown prose outside code
    results-to-readme.ts            # renders evals/results/*.json into the README Results section
  src/
    shared/                         # imported by scripts too: erasable syntax only, no enums
      contracts.ts                  # RawRecord, JobSpec, LoadResult, TransformResult, RunPlan (mirrors contracts/*.json)
      metrics.ts                    # the five metric ids and labels (as const)
      sources.ts                    # SourceId = "hris" | "ats" | "talent"
    worker/
      index.ts                      # default export {fetch, queue, scheduled}; exports Coordinator, SinkRoller, WarehouseRunWorkflow
      app.ts                        # Hono app assembly
      config.ts                     # parseConfig(env, requestHost): AppConfig, fail-closed rules
      auth/access.ts                # verifyAccessJwt(), keyset selection (remote JWKS or DEV_ACCESS_JWKS)
      auth/roles.ts                 # Principal, Role, requireRole()
      ingest/routes.ts              # POST /v1/ingest/:source
      ingest/normalize.ts           # per-source envelope -> RawRecord
      ingest/canonical-json.ts      # canonical JSON (integers only) + sha256
      lake/sink.ts                  # LakeSink, BasinStreamSink, LocalRollingSink
      lake/sink-roller.ts           # SinkRoller Durable Object (local stand-in)
      lake/lake-events.ts           # queue consumer for R2-notification-shaped messages
      lake/catalog-poll.ts          # Iceberg REST loadTable against Basin Catalog (production trigger)
      orchestration/coordinator.ts  # Coordinator Durable Object (SQLite)
      orchestration/coordinator-sql.ts
      orchestration/warehouse-run.ts# WarehouseRunWorkflow
      orchestration/dispatcher.ts   # RunnerDispatcher, PollDispatcher, CloudRunDispatcher
      orchestration/gcp-token.ts    # service-account JWT bearer grant with jose, token cache
      orchestration/triggers.ts     # scheduled() logic
      api/public.ts                 # /v1/health, /api/runs, /api/metrics, /api/freshness, /api/replay
      api/ops.ts                    # /api/ops/* operator checks used by doctor
      api/internal.ts               # /internal/jobs/*, /internal/runs/:id/artifacts
      api/dev.ts                    # /internal/dev/* (only when ENVIRONMENT=local)
      ai/providers.ts               # AiProvider: stub, openai-compatible, workers-ai (above cut)
      ai/ask.ts                     # minimal /api/ask: question -> MetricQuery -> answer from snapshot (above cut)
      reports.ts                    # R2 report writers
    web/                            # below cut line: React dashboard
  test/
    setup/worker-vars.ts
    worker/*.test.ts                # runs in workerd via @cloudflare/vitest-plugin
    node/*.test.ts                  # scripts, contracts, prose check, config names
    web/*.test.tsx                  # below cut line
  pipeline/
    pyproject.toml
    uv.lock
    src/peoplelake/
      __init__.py
      cli.py                        # argparse entry point `peoplelake`
      config.py                     # env -> Settings (pydantic)
      prng.py                       # SplitMix64 PRNG (platform and version stable)
      canonical.py                  # canonical JSON shared with the Worker golden
      generator/
        profiles.py                 # exact counts for "full" and "small"
        reference.py                # departments, jobs, locations (also committed as seeds)
        world.py                    # true world: employees, spells, timelines, offers
        hris.py, ats.py, talent.py  # source envelopes from the world (incl. recorded errors, corrections, rescinds)
        oracle.py                   # expected metrics and expected R6/R11 results from the true world
        manifest.py                 # counts + dataset sha256
      sim/
        plan.py                     # delivery plans: baseline + S1..S5 perturbations
        client.py                   # posts batches to /v1/ingest/:source
      lake/
        schema.py                   # Arrow/Iceberg schema mirroring infra/cloudflare/stream-schema.json
        catalog.py                  # local SqlCatalog or Basin RestCatalog
        committer.py                # local stand-in: sink files -> Iceberg snapshots (recommit flag for S2)
        reader.py                   # incremental reads with full-scan fallback
      warehouse/
        base.py                     # Warehouse protocol
        duckdb_wh.py                # open_duckdb(): default config, read-write, SET TimeZone='UTC'
        bigquery_wh.py
        loader.py                   # load job orchestration, load_log
        digest.py                   # canonical digests (ADR 0005)
        dbt_runner.py               # in-process dbtRunner + run_results parsing
      runner/
        client.py                   # WorkerClient (claim, heartbeat, result, artifact)
        jobs.py                     # LoadJob, TransformJob, fault hooks
        main.py                     # poll loop and --until-idle mode
      auth/dev_tokens.py            # dev keys + RS256 tokens; Access service-token headers for prod
      stack.py                      # local stack manager (wrangler dev, runner, ticker) with process-group cleanup
      devtools/
        lint_sql.py                 # sqlglot lint: ORDER BY and window ORDER BY need explicit NULLS
        clean_clone.py              # git clone HEAD to a temp dir, uv sync, dbt parse, smoke tests
      evals/
        scenarios.py
        freshness.py
        report.py
      prod/
        bootstrap_gcp.py
        doctor_gcp.py
        drills.py                   # restore drill, scenario drill (into *_drill datasets)
        demo_masking.py
        reset.py                    # guarded full production reset (lake table, datasets, Coordinator)
    tests/
      test_generator_counts.py, test_generator_determinism.py, test_generator_world_rules.py, test_oracle.py,
      test_oracle_seeds_committed.py, test_canonical_json_golden.py, test_contracts.py, test_lake_committer.py,
      test_reader.py, test_loader_duckdb.py, test_single_owner.py, test_timezone_utc.py, test_bigquery_loader_sql.py,
      test_bq_manifest.py, test_bucket_cursors.py, test_digest.py, test_dev_tokens.py, test_plan_scenarios.py,
      test_stack_cleanup.py, test_bootstrap_plan.py, test_restore_drill_sql.py
  warehouse/                        # dbt project "peoplelake"
    dbt_project.yml                 # vars: pl_profile (default from env PL_PROFILE)
    profiles.yml                    # env-var driven, no secrets
    macros/                         # section 11.8
    models/
      sources.yml
      staging/   stg_events.sql, stg_hris__worker_events.sql, stg_ats__requisitions.sql, stg_ats__applications.sql, stg_ats__offers.sql, stg_talent__compensation_changes.sql, stg_talent__reviews.sql, _staging.yml
      intermediate/ int_hris__effective_events.sql, int_hris__spells.sql, int_hris__attribute_timeline.sql, _intermediate.yml
      core/      dim_date.sql, dim_department.sql, dim_job.sql, dim_location.sql, dim_employee_history.sql, dim_employee.sql, fct_employment_events.sql, fct_offers.sql, fct_workforce_monthly.sql, metrics_workforce_monthly.sql, _core.yml
      restricted/ fct_compensation_history.sql, fct_performance_reviews.sql, _restricted.yml
      reporting/ rpt_workforce_monthly.sql, rpt_offer_acceptance_monthly.sql, _reporting.yml
      ops/       ops_delivery_stats.sql, ops_event_freshness.sql, ops_anomalies.sql, _ops.yml
    seeds/
      reference/ ref_departments.csv, ref_jobs.csv, ref_locations.csv   # committed
      oracle/    oracle_workforce_monthly.csv (936 rows: 468 per profile, `profile` column), expected_event_counts.csv (`profile` column)  # committed, regenerated and diffed by pytest
    tests/reconciliation/  R1..R11 singular tests (section 11.6)
  evals/
    ask/questions.jsonl             # below cut line
    results/                        # committed JSON outputs of runs made in a session (README cites these)
  docs/
    adr/0001..0008-*.md
    runbooks/restore.md, replay.md, rotate-tokens.md, prod-reset.md
  .github/workflows/
    ci.yml
    eval-full.yml
```

## 5. Synthetic data generator

### 5.1 Determinism
- PRNG: in-repo SplitMix64 (`prng.py`) seeded with `20261010`, so outputs do not depend on Python's `random` implementation or platform.
- IDs: `event_id = uuid5(NAMESPACE_PL, f"{profile}/{source}/{source_sequence}")` with a fixed namespace UUID. Employees `E000001..`, candidates `C000001..`, requisitions `Q000001..`, applications `A000001..`, offers `O000001..`.
- Canonical output: one JSONL file per source sorted by `source_sequence`, canonical JSON (sorted keys, no spaces, UTF-8). `manifest.json` records per-source and per-type counts and `dataset_sha256` (sha256 over the three files in source order). A test pins the sha256 for both profiles, so macOS and ubuntu CI must agree byte for byte.
- Simulated time: business dates 2010-01-01 to 2025-12-31 (initial population hire dates 2012-01-01 to 2022-12-31; activity window 2023-01-01 to 2025-12-31; 50 accepted offers start 2026-01-05 to 2026-01-30). `data_as_of = 2025-12-31`.
- Reference data: 12 departments `D01..D12`, 30 job codes `J01..J30` with levels, 6 locations `L1..L6` (committed seeds).

### 5.2 Exact counts (the generator asserts these and raises if any eligibility pool is too small)

**Profile `full` (100,000 events)**

| Source | Event type | Count | Construction |
|---|---|---:|---|
| hris | worker.hired | 6,400 | 4,000 initial population (`hire_source=initial_load`) + 2,400 external hires dated 2023-02-01..2025-12-31 |
| hris | worker.rehired | 150 | among effectively terminated employees, at least 90 days after termination, same `employee_id`, `spell_no` 2 |
| hris | worker.terminated | 1,960 | 1,900 effective + 60 later rescinded; all dated in window |
| hris | worker.transferred | 1,500 | department change |
| hris | worker.job_changed | 3,000 | 1,800 `promotion`, 1,200 `lateral` |
| hris | worker.fte_changed | 800 | FTE in {1.0, 0.8, 0.6, 0.5} |
| hris | worker.event_corrected | 600 | 250 hire-date, 150 termination-date, 120 transfer-department, 80 fte-change value; recorded 1..60 days after the original |
| hris | worker.event_rescinded | 60 | all target terminations; recorded 1..30 days after |
| **hris total** | | **14,470** | |
| ats | requisition.opened | 2,900 | |
| ats | requisition.closed | 2,700 | 2,600 `filled` + 100 `cancelled` (200 remain open) |
| ats | application.submitted | 30,000 | |
| ats | application.stage_changed | 13,530 | 3 per offered application (9,600) + 1,965 rejected applications x 2 |
| ats | offer.extended | 3,200 | |
| ats | offer.accepted | 2,600 | 2,400 external hires + 150 rehires + 50 pending starts in 2026-01 |
| ats | offer.declined | 520 | |
| ats | offer.rescinded | 80 | withdrawn before decision; excluded from acceptance rate |
| **ats total** | | **55,530** | |
| talent | compensation.changed | 19,500 | 4,000 initial + 2,400 hire + 150 rehire + 10,500 merit (3 cycles x 3,500, effective 04-01 of 2023/2024/2025, tenure >= 90 days) + 1,800 promotion + 650 adjustment |
| talent | review.submitted | 10,500 | 3 annual cycles x 3,500, effective 12-15 of 2023/2024/2025, tenure >= 180 days |
| **talent total** | | **30,000** | |
| **all** | | **100,000** | |

True-world totals the oracle and tests rely on: 6,400 employee ids; 6,550 employment spells; 2,550 hires in window (2,400 external + 150 rehires); 1,900 departures in window; headcount 4,000 at 2022-12-31 and 4,650 at 2025-12-31; overall offer acceptance 2,600 / 3,120 = 0.833333.

**Profile `small` (10,000 events, used by PR CI)**: hris 1,447 (hired 640 = 400 + 240; rehired 15; terminated 196 = 190 + 6; transferred 150; job_changed 300 = 180 + 120; fte_changed 80; corrected 60 = 25/15/12/8; rescinded 6), ats 5,553 (opened 290; closed 270 = 260 + 10; applications 3,000; stage changes 1,353 = 960 + 196 x 2 + 1 x 1; extended 320; accepted 260 = 240 + 15 + 5; declined 52; rescinded 8), talent 3,000 (compensation 1,950 = 400 + 240 + 15 + 3 x 350 + 180 + 65; reviews 1,050 = 3 x 350). Total 10,000. Headcount 400 then 465.

### 5.3 World rules (keep histories unambiguous; every rule is asserted by `test_generator_world_rules.py`)
- At most one HRIS event per employee per calendar day (corrections preserve this).
- A corrected date stays strictly between the neighbouring events of the same employee.
- Hire-date corrections (250 full, 25 small) apply only to in-window hires and rehires, shift the date by 1 to 20 days, and never move the hire on or before the accepted offer's decision date. Exactly 125 of the 250 (12 of the 25 on the small profile) cross a month boundary so restatements are exercised; the generator picks originals near month ends to make this possible and raises if it cannot.
- Termination-date corrections never move a termination before the employee's last talent event or before the spell's last other HRIS event.
- Every talent event tied to a hire or rehire uses the true (corrected) hire date: initial comp for the initial population, the hire or rehire comp event, and tenure eligibility for merit (>= 90 days) and reviews (>= 180 days). Promotions have a comp event on the promotion date.
- In-window hires and rehires carry `ats_candidate_id`; the accepted offer's `start_date` equals the original recorded hire date, so the 250 corrected hires need the 30-day offer-to-hire tolerance in R6, and the 1..20 day bound keeps them inside it.
- Each accepted offer fills one requisition; requisitions open 30..90 days before start; offers are decided 14..45 days before start; external hires begin 2023-02-01 so their offers fall inside the window.
- `oracle.py` computes the expected results of R6 (offer to hire) and R11 (open anomalies) from the true world; pytest asserts both are empty on both profiles. This test is written before any dbt model.

### 5.4 Source envelopes (three shapes on purpose; parsing happens in dbt staging, which is the T in ELT)

```json
// POST /v1/ingest/hris
{"events":[{"eventId":"<uuid>","eventType":"worker.hired","workerId":"E000123","sequence":1234,
  "recordedAt":"2023-02-01T15:04:05Z","effectiveDate":"2023-02-01","schemaVersion":1,
  "data":{"spell_no":1,"department_id":"D04","job_code":"J12","location_id":"L2","fte_bp":10000,
          "ats_candidate_id":"C001777","hire_source":"external"}}]}
// POST /v1/ingest/ats
{"records":[{"id":"<uuid>","type":"offer.accepted","object":{"kind":"offer","id":"O000321"},"seq":555,
  "occurred_at":"2023-01-10T09:00:00Z","effective_on":"2023-01-10","v":1,
  "attributes":{"offer_id":"O000321","start_date":"2023-02-06"}}]}
// POST /v1/ingest/talent
{"items":[{"uuid":"<uuid>","kind":"compensation.changed","subject":"E000123","revision":42,
  "updated":"2024-03-20T12:00:00Z","asOf":"2024-04-01","version":1,
  "body":{"change_id":"K004567","reason":"merit","base_salary":123400,"currency":"USD","bonus_target_bp":1000}}]}
```

Payload numbers are integers only: FTE in basis points (`fte_bp`: 10000, 8000, 6000, 5000) and bonus target in basis points (`bonus_target_bp`). `JSON.stringify(1.0)` prints `1` while Python prints `1.0`, so non-integral numbers would make the Worker's `payload_sha256` differ from a Python canonicalization of the same payload. Canonical JSON = sorted keys, no whitespace, ASCII only, integers only; zod and pydantic reject non-integers; `contracts/golden/canonical-json.json` is asserted byte for byte by both vitest and pytest.

Payload fields per type:
- hris: hired/rehired `{spell_no, department_id, job_code, location_id, fte_bp, ats_candidate_id|null, hire_source}`; terminated `{termination_type: voluntary|involuntary, reason_code}`; transferred `{from_department_id, to_department_id}`; job_changed `{from_job_code, to_job_code, change_type}`; fte_changed `{from_fte_bp, to_fte_bp}`; event_corrected `{corrects_event_id, corrected_fields: {effective_date?|to_department_id?|to_fte_bp?}}`; event_rescinded `{rescinds_event_id}`.
- ats: requisition.opened `{requisition_id, department_id, job_code}`; requisition.closed `{requisition_id, close_reason}`; application.submitted `{application_id, requisition_id, candidate_id}`; application.stage_changed `{application_id, from_stage, to_stage}`; offer.extended `{offer_id, application_id, requisition_id, candidate_id, proposed_start_date}`; offer.accepted `{offer_id, start_date}`; offer.declined/rescinded `{offer_id}`.
- talent: compensation.changed `{change_id, reason, base_salary, currency, bonus_target_bp}`; review.submitted `{review_id, cycle, rating (1..5), reviewer_id}`.

### 5.5 Oracle
`oracle.py` computes, from the true world (not from events), for every month 2023-01..2025-12 and every department plus `ALL` (36 x 13 = 468 rows per profile): `headcount`, `fte`, `hires`, `rehires`, `departures`, `transfers_in`, `transfers_out`, `offers_extended`, `offers_accepted`, `offers_declined`, `offer_acceptance_rate`. Both profiles are written to the committed seed `warehouse/seeds/oracle/oracle_workforce_monthly.csv` (936 rows, `profile` column, a few tens of KB), and the manifest counts to `warehouse/seeds/oracle/expected_event_counts.csv` (`profile` column). R7 and R10 filter on `profile = '{{ var("pl_profile") }}'`; `pl_profile` defaults to env `PL_PROFILE`, which the prod runner job sets to `full`. Nothing the warehouse needs is gitignored. `test_oracle_seeds_committed.py` regenerates both files and diffs them against the committed ones.

### 5.6 CLI
```bash
uv run --project pipeline peoplelake generate --profile full  --out .data/generated/full
uv run --project pipeline peoplelake generate --profile small --out .data/generated/small --check   # verifies pinned sha256
uv run --project pipeline peoplelake generate --write-seeds     # rewrites warehouse/seeds/oracle/* for both profiles
```

## 6. Data contracts

### 6.1 RawRecord (one row per accepted delivery; identical in stream, Iceberg and warehouse raw table)
| Column | Type | Source |
|---|---|---|
| event_id | string | source envelope |
| source | string | `hris` \| `ats` \| `talent` |
| event_type | string | envelope |
| entity_id | string | workerId / object.id / subject |
| source_sequence | int64 | sequence / seq / revision |
| source_updated_at | timestamp (UTC, RFC 3339 on the wire) | recordedAt / occurred_at / updated |
| effective_date | string `YYYY-MM-DD` | effectiveDate / effective_on / asOf |
| schema_version | int32 | schemaVersion / v / version |
| payload | string (canonical JSON of data/attributes/body) | envelope |
| payload_sha256 | string (hex) | Worker |
| received_at | timestamp | Worker clock |
| delivery_id | string (uuid v4) | Worker, one per record per request |
| ingest_request_id | string | Worker |
| producer | string | `peoplelake-ingest/<git sha or version>` |

Warehouse-only columns added by the loader: `_pl_snapshot_id` (string), `_pl_load_run_id`, `_pl_load_job_id`, `_pl_loaded_at` (timestamp), `_pl_load_seq` (int64: the Coordinator's monotonic load sequence for the run, `generation_epoch_s * 1,000,000 + run_seq`, so it keeps increasing even if Coordinator storage is ever reset).

### 6.2 Basin stream schema (`infra/cloudflare/stream-schema.json`)
Structured stream using only verified types (`string`, `int32`, `int64`, `timestamp`): the 14 columns above, all `"required": true`. Invalid records on a structured stream are "accepted at ingestion but dropped during processing" (docs), so the Worker validates before `send()`. Schemas cannot be modified after stream creation (docs); a schema change means a new stream + sink + table (runbook).

`infra/cloudflare/pipeline.sql`:
```sql
INSERT INTO peoplelake_raw_sink
SELECT event_id, source, event_type, entity_id, source_sequence, source_updated_at, effective_date,
       schema_version, payload, payload_sha256, received_at, delivery_id, ingest_request_id, producer
FROM peoplelake_raw_stream;
```
Names use underscores because SQL references them. The sink auto-creates namespace `peoplelake` and table `raw_events`; "Sinks cannot be created for existing Iceberg tables" (docs), so setup never pre-creates the production table.

### 6.3 Job contracts (`contracts/*.schema.json`, mirrored by `src/shared/contracts.ts` and pydantic models)
```ts
type JobKind = "load" | "transform";
interface JobSpec { job_id: string; run_id: string; load_seq: number; kind: JobKind; attempt: number; mode: "incremental" | "replay";
  input: { from_snapshot: string | null; to_snapshot?: string | null; full_refresh: boolean; dataset_suffix?: string };
  lease_seconds: number; faults?: FaultSpec[] }            // faults only when EVAL_FAULTS_ENABLED
interface LoadResult { job_id: string; run_id: string; attempt: number; status: "succeeded" | "failed" | "expired";
  lake: { table: "peoplelake.raw_events"; from_snapshot: string | null; to_snapshot: string | null; snapshots_read: number; fallback_full_scan: boolean };
  rows_read: number; rows_inserted: number; duplicate_deliveries_skipped: number; unique_new_events: number;
  raw_max_load_seq: number | null;                         // max _pl_load_seq present in the raw table after the load
  min_effective_date_new: string | null; received_histogram_10s: [number, number][]; warehouse: "duckdb" | "bigquery";
  duration_ms: number; error?: string }
interface TransformResult { job_id: string; run_id: string; attempt: number; status: "succeeded" | "failed" | "expired";
  dbt: { success: boolean; models_ok: number; models_error: number; tests_pass: number; tests_warn: number; tests_error: number; elapsed_ms: number; bytes_billed?: number };
  checks: { error: Record<string, number>; warn: Record<string, number> };
  digests: Record<PublishedModel, string>; digest_version: 1; engine: "duckdb" | "bigquery";
  transformed_through_seq: number;                         // max _pl_load_seq in stg_events after the build
  ops_freshness_histogram_10s: [number, number][];         // from ops_event_freshness, computed by the runner (ADR 0008)
  metrics_artifact: { key: string; sha256: string; rows: number };   // uploaded first via /internal/runs/:id/artifacts/metrics
  duration_ms: number; error?: string }
```
Event payloads stay far below the verified 1 MiB Workflow event limit because the metrics snapshot travels through R2, not through the event.

## 7. Cloudflare Worker

### 7.1 `wrangler.jsonc` (shape the build writes)
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "peoplelake-local",            // never the production name: a plain `wrangler deploy` cannot replace production
  "workers_dev": false,
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "vars": {
    "ENVIRONMENT": "local", "AUTH_MODE": "dev", "LAKE_MODE": "local", "RUNNER_DISPATCH": "poll", "RUNS_ENABLED": "true",
    "ACCESS_TEAM_DOMAIN": "https://peoplelake-dev.local", "ACCESS_AUD": "peoplelake-dev",
    "ACCESS_ROLE_MAP": "{\"emails\":{\"dev@peoplelake.local\":[\"viewer\",\"operator\"]},\"service_tokens\":{\"src-hris.access\":\"source:hris\",\"src-ats.access\":\"source:ats\",\"src-talent.access\":\"source:talent\",\"runner.access\":\"runner\"}}",
    "JOB_LEASE_SECONDS": "60", "JOB_CLAIM_TIMEOUT_SECONDS": "30", "JOB_MAX_ATTEMPTS": "3", "RUN_TIMEOUT_MINUTES": "10",
    "SINK_ROLL_SECONDS": "60", "LOCAL_SINK_MAX_RECORDS": "50000", "HEARTBEAT_MINUTES": "0",
    "EVAL_FAULTS_ENABLED": "true", "AI_PROVIDER": "stub", "LLM_BASE_URL": "http://127.0.0.1:8150/v1"
  },
  "r2_buckets": [
    { "binding": "LAKE_BUCKET", "bucket_name": "peoplelake-lake-local" },
    { "binding": "REPORTS_BUCKET", "bucket_name": "peoplelake-reports-local" }
  ],
  "queues": {
    "producers": [{ "binding": "LAKE_EVENTS", "queue": "peoplelake-lake-events" }],
    "consumers": [{ "queue": "peoplelake-lake-events", "max_batch_size": 50, "max_batch_timeout": 2, "max_retries": 5, "dead_letter_queue": "peoplelake-lake-events-dlq" }]
  },
  "durable_objects": { "bindings": [
    { "name": "COORDINATOR", "class_name": "Coordinator" },
    { "name": "SINK_ROLLER", "class_name": "SinkRoller" } ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Coordinator", "SinkRoller"] }],
  "workflows": [{ "name": "peoplelake-warehouse-run", "binding": "WAREHOUSE_RUN", "class_name": "WarehouseRunWorkflow" }],
  "pipelines": [{ "binding": "RAW_STREAM", "stream": "00000000000000000000000000000000" }],
  "triggers": { "crons": ["* * * * *"] },
  "env": {
    "production": {
      "name": "peoplelake",
      "workers_dev": true,
      "preview_urls": false,
      "vars": {
        "ENVIRONMENT": "production", "AUTH_MODE": "access", "LAKE_MODE": "basin", "RUNNER_DISPATCH": "cloudrun",
        "RUNS_ENABLED": "__PL_RUNS_ENABLED__",
        "ACCESS_TEAM_DOMAIN": "__PL_ACCESS_TEAM_DOMAIN__", "ACCESS_AUD": "__PL_ACCESS_AUD__",
        "ACCESS_ROLE_MAP": "__PL_ACCESS_ROLE_MAP__",
        "GCP_PROJECT": "__PL_GCP_PROJECT__", "GCP_REGION": "us-central1", "CLOUD_RUN_JOB": "peoplelake-runner",
        "BASIN_CATALOG_URI": "__PL_CATALOG_URI__", "BASIN_CATALOG_PREFIX": "__PL_CATALOG_PREFIX__",
        "JOB_LEASE_SECONDS": "600", "JOB_CLAIM_TIMEOUT_SECONDS": "300", "JOB_MAX_ATTEMPTS": "3", "RUN_TIMEOUT_MINUTES": "45",
        "SINK_ROLL_SECONDS": "60", "HEARTBEAT_MINUTES": "360", "RUNNER_SEEN_WINDOW_SECONDS": "60", "EVAL_FAULTS_ENABLED": "false",
        "AI_PROVIDER": "workers-ai", "AI_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "AI_GATEWAY_ID": "peoplelake"
      },
      "ai": { "binding": "AI" },
      "r2_buckets": [{ "binding": "REPORTS_BUCKET", "bucket_name": "peoplelake-reports" }],
      "queues": { "consumers": [{ "queue": "peoplelake-lake-events", "max_batch_size": 50, "max_batch_timeout": 5, "max_retries": 5, "dead_letter_queue": "peoplelake-lake-events-dlq" }] },
      "durable_objects": { "bindings": [
        { "name": "COORDINATOR", "class_name": "Coordinator" },
        { "name": "SINK_ROLLER", "class_name": "SinkRoller" } ] },
      "workflows": [{ "name": "peoplelake-warehouse-run", "binding": "WAREHOUSE_RUN", "class_name": "WarehouseRunWorkflow" }],
      "pipelines": [{ "binding": "RAW_STREAM", "stream": "__PL_STREAM_ID__" }],
      "triggers": { "crons": ["* * * * *"] }
    }
  }
}
```
Facts behind this shape (all verified in this session with wrangler 4.149.0 in a scratch project):
- An `ai` binding makes `wrangler dev` "Establishing remote connection..." and it never became ready without login; so `ai` exists only in `env.production`, and vitest injects a mocked `AI` binding.
- A `pipelines` binding with a dummy stream id runs offline (mode `local`), and its `send()` discards data.
- `wrangler types` on this layout emits `AI?: Ai` in the base Env and `LAKE_MODE: "basin" | "local"`; `RAW_STREAM` is typed `Pipeline<PipelineRecord>` from `cloudflare:pipelines`.
- `wrangler types` reads `.dev.vars` when it exists and adds those names to `Env` and to a `ProcessEnv` Pick. Reproduced: types generated with a local `.dev.vars` fail `wrangler types --check` on a machine without one ("Types at worker-configuration.d.ts are out of date", exit 1). Hence `npm run typegen` and `typegen:check` both run `wrangler types worker-configuration.d.ts --strict-vars=false --env-file .dev.vars.example`; with that flag `--check` passes with `.dev.vars` present (even with extra keys) and absent (reproduced).
- `wrangler deploy` with no `--env` on a config that has environments only warns ("Multiple environments are defined ... no target environment was specified") and targets the top-level name. With the top level named `peoplelake-local` and `workers_dev: false`, an accidental plain deploy can never replace the production Worker `peoplelake`; `test/node/config-names.test.ts` asserts the two names differ. The README says to deploy only with `npm run deploy`.
- `wrangler deploy --env production --dry-run` bundles offline. `wrangler deploy --secrets-file <file>` uploads secrets with the version (used by setup:prod so secret values never reach argv or logs).
- `"stream"` is the current binding key; `"pipeline"` is deprecated (docs).
- Local cron does not auto-fire. wrangler 4.149 prints `/cdn-cgi/local/scheduled`; `GET /cdn-cgi/handler/scheduled?cron=...` also worked. The ticker calls the printed path and falls back to the other.
- Deploying a Worker that has Workflows requires a registered workers.dev subdomain (wrangler source: "You need to register a workers.dev subdomain before deploying Workflows"); setup:prod registers one (section 21.1).
- `preview_urls` is a valid config key (in wrangler's config schema); previews are off in production so no uncovered hostname exists.

`scripts/render-wrangler.ts` copies `wrangler.jsonc` to `wrangler.production.jsonc` (gitignored) replacing `__PL_*__` from `.prod/state.json`; `scripts/predeploy-check.ts` refuses to deploy if placeholders remain, if `AUTH_MODE` is not `access`, if `EVAL_FAULTS_ENABLED` is not `false`, or if `RUNS_ENABLED=true` while `.prod/state.json` lacks a passing GCP bootstrap. `ACCESS_AUD=pending` is accepted only with `RUNS_ENABLED=false` (the fail-closed first deploy, section 21.1). Production secrets (never in config): `GCP_DISPATCHER_KEY`, `R2_CATALOG_TOKEN`. Local secret in `.dev.vars`: `DEV_ACCESS_JWKS`. `.dev.vars.example` lists all three names with empty values.

### 7.2 `AppConfig` (`src/worker/config.ts`)
`parseConfig(env, requestHost)` returns a frozen object or throws `ConfigError`. Fail-closed rules: when `ENVIRONMENT=production`, then `AUTH_MODE` must be `access`, `LAKE_MODE` must be `basin`, `RUNNER_DISPATCH` must be `cloudrun`, `EVAL_FAULTS_ENABLED` must be `false`, dev routes are not mounted, and `ACCESS_TEAM_DOMAIN` must match `^https://[a-z0-9-]+\.cloudflareaccess\.com$`; when `RUNS_ENABLED=true` in production, `GCP_DISPATCHER_KEY`, `R2_CATALOG_TOKEN`, `BASIN_CATALOG_URI` and `BASIN_CATALOG_PREFIX` must be non-empty. When `ENVIRONMENT=local`, the request host must be `127.0.0.1` or `localhost` (so a stray deploy of the local config serves nothing). A config error turns every request into 500 `{"error":"config"}`, scheduled handlers do nothing, and a test covers each rule.

### 7.3 HTTP API
| Method + path | Role | Behavior |
|---|---|---|
| GET `/v1/health` | none | `{ok, version, environment, lake_mode}` only |
| GET `/v1/health/auth` | any authenticated | echoes the principal and roles (doctor uses it) |
| POST `/v1/ingest/:source` | `source:<source>` | validates whole batch (max 500 events, max 1 MiB body) with zod; all-or-nothing: 422 with per-index reasons, or 202 `{request_id, accepted}` after `LakeSink.send` resolves; then `Coordinator.noteIngest(count, max_received_at)` |
| GET `/api/runs?limit=&format=summary\|full` | viewer, runner | run ledger |
| GET `/api/runs/:run_id` | viewer, runner | run + jobs |
| POST `/api/runs` | operator | `requestRun("manual")` |
| POST `/api/replay` | operator | `requestRun("replay", mode="replay")` |
| GET `/api/metrics/latest` | viewer | committed metrics snapshot from `REPORTS_BUCKET` |
| GET `/api/freshness?window=24h` | viewer | per-run freshness from ledger histograms |
| POST `/api/ask` | viewer | minimal: question to validated `MetricQuery`, answer from the committed snapshot (section 13) |
| GET `/api/ops/lake` | operator | catalog current snapshot, newest append snapshot, committed watermark, last lake event, last poll error |
| GET `/api/ops/dispatch` | operator | mints a GCP access token (never returned) and reports `{ok, expires_in}`; `?execute=1` also starts one runner execution |
| GET `/api/ops/ai` | operator | one tiny Workers AI call through the gateway; returns `{ok, gateway_log_id_present}` |
| POST `/internal/jobs/claim` `{worker_id}` | runner | 200 JobSpec (oldest queued job) or 204; records `runner_last_seen_at` |
| POST `/internal/jobs/:job_id/heartbeat` | runner | extends lease, 409 if not the holder |
| POST `/internal/jobs/:job_id/result` | runner | idempotent; 200 `{duplicate: boolean}` |
| PUT `/internal/runs/:run_id/artifacts/metrics` | runner | writes `reports/metrics/<run_id>.json` (sha256 checked) |
| GET `/internal/dev/sink/files?after=` | runner (local only) | lists roll files `{key, etag, size}` |
| GET `/internal/dev/sink/files/:key` | runner (local only) | file body |
| POST `/internal/dev/sink/flush` | operator (local only) | force roll |
| POST `/internal/dev/faults` | operator (local only) | install a fault schedule |

### 7.4 Ingest and sinks
```ts
interface LakeSink { send(records: RawRecord[]): Promise<void> }
class BasinStreamSink implements LakeSink { constructor(stream: Pipeline<PipelineRecord>) }   // production
class LocalRollingSink implements LakeSink { constructor(ns: DurableObjectNamespace<SinkRoller>) } // local stand-in
```
`normalize.ts` maps each envelope to RawRecord, canonicalizes the payload (section 5.4) and computes `payload_sha256`. `delivery_id` is minted per record per request, so a client retry yields a new delivery of the same event (by design, ADR 0001).

`SinkRoller` (Durable Object, SQLite, singleton `local-sink`): `append(records)` inserts into `buffer(seq INTEGER PRIMARY KEY AUTOINCREMENT, record_json TEXT)` and arms an alarm at `now + SINK_ROLL_SECONDS`; `roll(force)` writes `local-sink/raw_events/<roll_seq:08d>.ndjson` to `LAKE_BUCKET`, then deletes the rolled rows and increments `roll_seq` in one transaction, then sends `{account:"local", action:"PutObject", bucket:"peoplelake-lake-local", object:{key, size, eTag}, eventTime}` to `LAKE_EVENTS`, which mirrors the verified R2 notification fields. A crash between put and delete rewrites the same key with a superset; the committer treats `(key, etag)` as identity and the loader dedupes by `delivery_id`.

### 7.5 Queue consumer (`lake-events.ts`)
Accepts messages whose `object.key` ends with `.metadata.json` (production, Iceberg commits, optimization only because notifications for Basin-written objects are **[UNVERIFIED]**) or starts with `local-sink/` (local, the primary local trigger). For each batch: `Coordinator.markNewData(eventTime)` then `requestRun("lake-event")`; ack all. Malformed messages are acked and counted (`ops` counter) rather than retried forever; real failures retry (max 5) then go to `peoplelake-lake-events-dlq`.

### 7.6 Scheduled (`triggers.ts`)
Every minute, unless `RUNS_ENABLED` is false:
- **Production trigger (primary): catalog poll.** `GET {BASIN_CATALOG_URI}/v1/{BASIN_CATALOG_PREFIX}/namespaces/peoplelake/tables/raw_events` with `Authorization: Bearer {R2_CATALOG_TOKEN}` (Iceberg REST `loadTable`, the same endpoint pyiceberg's `RestCatalog` uses; the prefix value is recorded by setup:prod from `GET /v1/config?warehouse=...` and is **[UNVERIFIED]** until then). If the metadata lists an `append` snapshot with a sequence number above the committed watermark's, `requestRun("catalog")`. Compaction (`replace`) snapshots never trigger a run. This makes the trigger independent of Basin's commit latency and of R2 notifications. About 43,200 catalog reads a month against the 1M included.
- **Local trigger:** every SinkRoller roll enqueues a lake event (exact locally); the cron additionally starts a run when `last_ingest_at > last_run_started_at - (SINK_ROLL_SECONDS + 30 s)`.
- **Heartbeat:** when `HEARTBEAT_MINUTES > 0` (production 360, local 0 = off) and no run started in that window, start a load-only run. A run whose load inserts nothing and whose `raw_max_load_seq` is not above `transformed_through_seq` skips the transform and commits as a no-op (section 8.2), so heartbeats never run dbt or bill BigQuery queries beyond the load.
- Sweeps expired leases and timed-out runs (backed by the DO alarm).

## 8. Orchestration

### 8.1 Coordinator Durable Object (singleton `global`, SQLite)
```sql
CREATE TABLE runs (run_id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, load_seq INTEGER UNIQUE NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('incremental','replay')),
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','committed','failed')),
  requested_at INTEGER, started_at INTEGER, finished_at INTEGER, published_at INTEGER,
  from_snapshot TEXT, to_snapshot TEXT, rows_inserted INTEGER, duplicates_skipped INTEGER, transform_skipped INTEGER DEFAULT 0,
  load_attempts INTEGER DEFAULT 0, transform_attempts INTEGER DEFAULT 0,
  digests_json TEXT, checks_json TEXT, metrics_key TEXT, error TEXT);
CREATE TABLE jobs (job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('load','transform')),
  attempt INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','claimed','succeeded','failed','expired')),
  input_json TEXT NOT NULL, created_at INTEGER, claimed_at INTEGER, claimed_by TEXT, lease_until INTEGER,
  finished_at INTEGER, result_json TEXT, dispatch_ref TEXT, UNIQUE (run_id, kind, attempt));
CREATE TABLE watermarks (name TEXT PRIMARY KEY, value TEXT, run_id TEXT, updated_at INTEGER);  -- raw_events, transformed_through_seq
CREATE TABLE run_freshness (run_id TEXT, bucket_start_s INTEGER, events INTEGER, PRIMARY KEY (run_id, bucket_start_s));
CREATE TABLE ingest_minutes (minute INTEGER PRIMARY KEY, requests INTEGER, records INTEGER);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);
  -- generation (epoch seconds at first init), run_seq, active_run_id, pending_mode, last_ingest_at, last_lake_event_at,
  -- runner_last_seen_at, last_dispatch_at, gcp_token_json, catalog_last_poll_json, faults_json
```
RPC methods (all idempotent where noted):
- `requestRun(reason, mode = "incremental"): {run_id, started: boolean}`: single-flight. If a run is active, sets `pending` (replay wins over incremental) and returns the active id. Run ids are `r-<generation base36>-<seq:06d>` (for example `r-mgk3x2-000042`), so ids are never reused even if Coordinator storage is reset while Workflow instances are retained. It calls `WAREHOUSE_RUN.get(id)` before `create`, so a retried request is idempotent.
- `openRun(run_id): RunPlan` (idempotent): `from_snapshot = watermarks['raw_events'].value` (null in replay mode), `load_seq` of the run.
- `enqueueJob(run_id, kind, attempt, input): JobSpec` (idempotent on `(run_id, kind, attempt)`).
- `shouldDispatch(now): boolean`: false when a runner claimed or heartbeated within `RUNNER_SEEN_WINDOW_SECONDS` (a live runner in its idle window will claim the job), or when a dispatch happened within the last 90 s with no claim since; true otherwise.
- `claimJob(worker_id): JobSpec | null`: oldest queued job; sets `lease_until` and `runner_last_seen_at`.
- `heartbeat(job_id, worker_id)`; `completeJob(job_id, result): {duplicate}`: if the job is already terminal returns `duplicate: true` and sends nothing; otherwise stores the result and calls `env.WAREHOUSE_RUN.get(run_id).sendEvent({type: `${kind}-result-a${attempt}`, payload: result})`, catching and recording errors from instances that already finished.
- `alarm()`: queued jobs older than `JOB_CLAIM_TIMEOUT_SECONDS` and claimed jobs past `lease_until` become `expired`, and an `expired` result event is sent; runs older than `RUN_TIMEOUT_MINUTES` are failed and released.
- `commitRun(run_id, commit)`: idempotent; advances `raw_events` and `transformed_through_seq` only if the run is `active`; stores `published_at`, digests, checks, metrics key.
- `failRun(run_id, error)`, `releaseRun(run_id)`: starts the pending run if any.
- `noteIngest`, `markNewData`, `tick`, `pollCatalog`, `listRuns`, `getRun`, `getGcpToken`, `installFaults` (local only).

Event types follow the verified rules (letters, digits, `-`, `_`; no periods): `load-result-a1`, `transform-result-a2`. Attempt-scoped types guarantee a stale result from attempt 1 can never satisfy the wait for attempt 2. Events sent before the Workflow reaches `waitForEvent` are buffered (docs).

### 8.2 `WarehouseRunWorkflow extends WorkflowEntrypoint<Env, RunParams>`
`RunParams = { run_id: string; mode: "incremental" | "replay"; reason: string }`. Instance id = `run_id`. Steps (names are stable; tests address them):

1. `open-run`: `Coordinator.openRun` -> RunPlan.
2. For `kind` in [`load`, `transform`], `attempt` 1..`JOB_MAX_ATTEMPTS`:
   - `dispatch:<kind>:a<n>` (retries 5, exponential from 5 s): `enqueueJob`, then `dispatcher.dispatch()` only if `shouldDispatch`.
   - `wait:<kind>:a<n>`: `step.waitForEvent(<kind>-result-a<n>, { type, timeout })` with `timeout = lease + claim timeout + 60 s`; a thrown timeout is caught and treated as `expired`.
   - `succeeded` moves on. `failed` or `expired` tries the next attempt. After the last attempt the run fails with `NonRetryableError`.
   - The transform input carries `full_refresh = (mode === "replay")`.
   - Transform skip: in `incremental` mode, when the load inserted 0 rows and `raw_max_load_seq <= transformed_through_seq`, the run records `transform_skipped` and goes to commit with the previous committed digests and metrics key. The second condition matters: if an earlier run loaded rows but failed every transform attempt, the next run's load inserts nothing new yet the transform must still run.
3. `verify`: requires `dbt.success`, `dbt.tests_error === 0`, every `checks.error[*] === 0`, a digest for each of the 10 published models, and a matching metrics artifact sha256 (or a valid skip). Warn-level checks (completeness while data is still arriving) are recorded, not blocking.
4. `commit` (retries 5): `Coordinator.commitRun`, then writes `reports/runs/<run_id>.json` and copies the metrics artifact to `reports/metrics/latest.json` in `REPORTS_BUCKET` (deterministic keys; overwrite is harmless).
5. `release`: `Coordinator.releaseRun`.

The body is wrapped in `try/catch`: on any error a `fail-run` step records it, `release` runs, and the error is rethrown. Step CPU is I/O-bound (well under the verified 30 s paid default).

### 8.3 Dispatchers
```ts
interface RunnerDispatcher { dispatch(): Promise<{ mode: "poll" | "cloudrun"; ref?: string }> }
class PollDispatcher implements RunnerDispatcher {}   // no-op; the local runner polls /internal/jobs/claim
class CloudRunDispatcher implements RunnerDispatcher { // production
  constructor(o: { project: string; region: string; job: string; key: ServiceAccountKey; tokens: TokenCache; fetch?: typeof fetch }) {}
}
```
`CloudRunDispatcher`:
1. Access token from the cache (Coordinator `state.gcp_token_json`, refreshed 5 minutes before expiry), else mint: jose `importPKCS8(key.private_key, "RS256")`, `new SignJWT({scope: "https://www.googleapis.com/auth/cloud-platform"}).setProtectedHeader({alg: "RS256", kid: key.private_key_id, typ: "JWT"}).setIssuer(key.client_email).setSubject(key.client_email).setAudience("https://oauth2.googleapis.com/token").setIssuedAt().setExpirationTime("1h")`, then `POST https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` (the standard Google service-account JWT bearer grant).
2. `POST https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/{job}:run` with an empty body (no overrides) [V endpoint, docs]. The returned long-running operation name is stored as `jobs.dispatch_ref`.
3. The runner execution claims whatever job is queued, so no run id travels in the request. Without overrides, a leaked dispatcher key can only start the job as configured; it cannot change its arguments, environment or Worker URL.

Identity: service account `pl-dispatcher` with `roles/run.jobsExecutor` on the job only (permissions `run.jobs.run`, `run.executions.cancel`; verified in the Cloud Run roles reference). Its JSON key is the Worker secret `GCP_DISPATCHER_KEY`. Organizations created on or after 2024-05-03 enforce `iam.managed.disableServiceAccountKeyCreation` by default (verified); a project with no organization (a personal Gmail account) is unaffected. doctor checks this before setup creates the key; the fallback for a blocked project is in section 24 (risk 14).

A duplicate dispatch after a step retry is harmless: at most one runner holds a job lease, and an execution that finds no work exits after 15 s idle.

### 8.4 Fault injection (local and eval only)
`FaultSpec = { run_seq: number; kind: "crash_after_load" | "fail_transform_model" | "duplicate_result" | "skip_claim" | "commit_step_error" | "rewind_watermark" | "recommit_sink_files"; model?: string; snapshots?: number; count?: number }`. Installed through `POST /internal/dev/faults`, embedded into `JobSpec.faults`, and honored by:
- the runner (`jobs.py`): `crash_after_load`, `fail_transform_model` (sets env `PL_FAULT_FAIL_MODEL=<model>` for that dbt invocation; the `pl_fault_guard()` macro makes the model's SQL raise with `error()` in DuckDB or `ERROR()` in BigQuery; reproduced on DuckDB), `duplicate_result`, `skip_claim`;
- the Workflow: `commit_step_error` throws once, via a Coordinator flag;
- the Coordinator: `rewind_watermark{snapshots}` makes `openRun` use the `to_snapshot` committed `snapshots` runs earlier, so the loader re-reads data it already loaded;
- the committer: `recommit_sink_files{count}` sets a flag that bypasses the `(key, etag)` skip for the `count` most recent committed files and appends them again as new snapshots tagged `peoplelake.recommit=true`.
`parseConfig` refuses `EVAL_FAULTS_ENABLED=true` in production, a test asserts the production render has it `false`, and each fault kind has a unit test.

## 9. Lake

### 9.1 Iceberg table
Namespace `peoplelake`, table `raw_events`, schema = RawRecord (section 6.1). Locally `lake/schema.py` creates it with Arrow types `string`, `int64`, `int32`, `timestamp[us, tz=UTC]`. In production the sink creates it from the stream schema; the reader casts whatever physical types it finds (timestamp precision and zone are **[UNVERIFIED]** for sink-created tables) to the canonical Arrow schema.

### 9.2 Catalogs
```python
class LakeCatalog(Protocol):
    def current_snapshot_id(self) -> int | None: ...
    def read_appends(self, from_exclusive: int | None, to_inclusive: int | None) -> tuple[pa.Table, ReadInfo]: ...
def local_catalog(root: Path) -> SqlCatalog      # SqlCatalog("local", uri=f"sqlite:///{root}/catalog.db", warehouse=f"file://{root}/warehouse")
def basin_catalog(uri: str, warehouse: str, token: str) -> RestCatalog   # RestCatalog(name="basin", uri=..., warehouse=..., token=...)
```
`read_appends` uses `table.incremental_append_scan(from_snapshot_id_exclusive=..., to_snapshot_id_inclusive=...)` (verified in pyiceberg 0.12.0; it considers only `APPEND` snapshots, so compaction `replace` snapshots are skipped, verified in source). If the from-snapshot no longer exists (Basin snapshot expiration defaults to older than 30 days and at least 5 kept, per docs), it falls back to a full scan of the current snapshot and reports `fallback_full_scan: true`; the MERGE on `delivery_id` keeps this idempotent. Basin Catalog vends SigV4 credentials to engines (docs), so only the token is configured. `peoplelake lake catalog-info --target prod` prints the catalog URI, warehouse and REST prefix for setup:prod and the Worker's catalog poll.

### 9.3 Local committer (stand-in for the Basin sink's Iceberg commits)
`committer.commit_pending(worker, catalog, recommit=0)`: lists `/internal/dev/sink/files?after=`, skips `(key, etag)` pairs already present in snapshot summaries (`peoplelake.source-file`, `peoplelake.source-etag`), parses NDJSON into the canonical Arrow table, and appends with those snapshot properties (snapshot properties verified). `recommit > 0` (fault `recommit_sink_files`, eval only) re-appends that many already committed files. It runs at the start of every local `load` job. It never runs in production.

## 10. Python pipeline (`pipeline/`)

### 10.1 Warehouse protocol
```python
class Warehouse(Protocol):
    kind: Literal["duckdb", "bigquery"]
    def ensure_raw(self) -> None: ...
    def load_deliveries(self, batch: pa.Table, *, run_id: str, job_id: str, load_seq: int, snapshot_id: str | None) -> LoadStats: ...
    def fetch_model(self, model: PublishedModel) -> pa.Table: ...
    def reset(self, *, dataset_suffix: str | None = None) -> None: ...   # eval and drill only
```
- DuckDB (`.data/warehouse/peoplelake.duckdb`, ADR 0008): every connection goes through `open_duckdb(path)`, which calls `duckdb.connect(path)` with the default config, read-write, then `SET TimeZone='UTC'`. Never `read_only=True` and never a `config=` dict: dbt-duckdb opens the same file in the same process with `read_only=False, config={}` and DuckDB refuses a second in-process connection with a different configuration ("Can't open a connection to same database file with a different configuration", reproduced). Load: `INSERT INTO pl_raw.raw_event_deliveries SELECT b.*, ... FROM batch b WHERE NOT EXISTS (SELECT 1 FROM pl_raw.raw_event_deliveries r WHERE r.delivery_id = b.delivery_id)` inside a transaction, plus a `pl_ops.load_log` row; the connection is closed before dbt runs.
- BigQuery: Arrow to Parquet in memory; `load_table_from_file` into `pl_raw._stage_<job_id>` (`WRITE_TRUNCATE`, table expiration 1 day; batch loads are free per BigQuery pricing); then `MERGE pl_raw.raw_event_deliveries T USING pl_raw._stage_<job_id> S ON T.delivery_id = S.delivery_id WHEN NOT MATCHED THEN INSERT ROW` (sqlglot parses this as BigQuery); then `pl_ops.load_log`; then drop the stage table. `raw_event_deliveries` is partitioned by `DATE(_pl_loaded_at)` and clustered by `source, event_type, event_id`.
- `received_histogram_10s` is computed over newly inserted rows only.

### 10.2 Runner
```bash
uv run --project pipeline peoplelake runner poll --worker-url http://127.0.0.1:8791 --target local     # local loop
peoplelake runner run --until-idle 15 --target prod                                                    # Cloud Run Job container args
```
- Auth headers: local sends `Cf-Access-Jwt-Assertion: <dev RS256 token, role runner>` minted per request (5 min expiry); prod sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request and Access injects the JWT (compatible with strict service token authentication, which Zero Trust organizations created on or after 2026-10-05 have on by default: no `CF_Authorization` cookie is issued or honored, failures return 401/403 instead of a redirect).
- Load job: (local only) `committer.commit_pending`; then `read_appends(from_snapshot, current)`; then `Warehouse.load_deliveries` stamping `_pl_load_seq = JobSpec.load_seq`; then post the LoadResult with `raw_max_load_seq`.
- Transform job: dbt runs in-process through `dbtRunner` (one process owns the DuckDB file; partial parsing stays on). If seed checksums changed (or replay), `dbt seed`; then `dbt build --target <local|prod|prod-drill> --exclude-resource-type unit_test` (plus `--full-refresh` in replay). Unit tests run only in CI (section 17): they need the model relations to exist, and on an empty warehouse `dbt build` fails with "Not able to get columns for unit test ... because the relation doesn't exist" (reproduced on dbt-core 1.12.5 + dbt-duckdb 1.11.0); excluding them also avoids paying BigQuery for them. No per-run `--vars` (changed vars force a full re-parse): profile and dataset suffix come from env vars fixed for the process (`PL_PROFILE`, `PL_DATASET_SUFFIX`), faults from `PL_FAULT_FAIL_MODEL`. Then parse `target/run_results.json`; map test names to `checks.error` and `checks.warn`; compute digests and the `ops_event_freshness` histogram with its own connection; upload the metrics artifact; post the TransformResult. BigQuery transforms also report `bytes_billed` summed from the job statistics.
- Heartbeat every `lease/3`. A SIGTERM or exception posts `status: failed` with the error message (counts only, never row data; Cloud Run logs are private to the project but the rule stays).
- `--until-idle 15`: after the last job, keep polling `claim` every 2 s for 15 s, then exit 0.

### 10.3 Digests (ADR 0005)
Published models (10): `dim_department`, `dim_job`, `dim_employee_history`, `dim_employee`, `fct_employment_events`, `fct_offers`, `fct_workforce_monthly`, `metrics_workforce_monthly`, `fct_compensation_history`, `fct_performance_reviews`. For each: select the declared business columns (never `_pl_*` metadata, `received_at` or `delivery_id`) ordered by the declared primary key with explicit `NULLS LAST`; canonicalize (dates `YYYY-MM-DD`, timestamps ISO UTC with microseconds, numerics as decimal strings with 6 places, booleans `true`/`false`, null `null`); hash JSON lines with SHA-256. `digest_version: 1`. Tests pin a digest for a tiny fixture so DuckDB and a BigQuery-shaped Arrow table canonicalize identically.

### 10.4 Local stack manager
`peoplelake stack up` starts `npx wrangler dev --port 8791 --inspector-port 9241 --ip 127.0.0.1` (eval mode adds `--var JOB_LEASE_SECONDS:20 --var JOB_CLAIM_TIMEOUT_SECONDS:10` so S4 waits stay short), waits for `/v1/health`, starts the runner loop and (live mode only) a ticker calling the scheduled path every 60 s. `stack down` kills the process groups and asserts the ports are free. While the stack is up, only the runner process opens the DuckDB file (ADR 0008); eval drivers read digests, checks and freshness histograms from the ledger and open the file only after `stack down`. Used by evals and CI; `atexit` and signal handlers guarantee cleanup.

## 11. dbt project (`warehouse/`)

### 11.1 Profiles (`warehouse/profiles.yml`, no secrets)
```yaml
peoplelake:
  target: local
  outputs:
    local:
      type: duckdb
      path: "{{ env_var('PL_DUCKDB_PATH', '../.data/warehouse/peoplelake.duckdb') }}"
      threads: 4
      settings: {TimeZone: UTC}           # verified: a table model built with this reads UTC on this Mac
    prod:                                 # Cloud Run Job: attached SA pl-runner through the metadata server
      type: bigquery
      method: oauth
      project: "{{ env_var('PL_GCP_PROJECT') }}"
      dataset: pl_core
      location: "{{ env_var('PL_BQ_LOCATION', 'US') }}"
      threads: 8
      job_execution_timeout_seconds: 300
      job_retries: 2
      maximum_bytes_billed: 5000000000    # 5 GB per query; the whole raw table is about 0.1 GB
    prod-drill:                           # laptop: Nitish's ADC impersonating pl-runner, *_drill datasets only
      type: bigquery
      method: oauth
      project: "{{ env_var('PL_GCP_PROJECT') }}"
      dataset: pl_core_drill
      location: "{{ env_var('PL_BQ_LOCATION', 'US') }}"
      threads: 8
      job_execution_timeout_seconds: 300
      job_retries: 2
      maximum_bytes_billed: 5000000000
      impersonate_service_account: "{{ env_var('PL_RUNNER_SA') }}"
    bq_offline:                           # CI compile only; never connects
      type: bigquery
      method: oauth-secrets
      token: offline-compile-only
      project: peoplelake-offline
      dataset: pl_core
      location: US
      threads: 4
```
`generate_schema_name` maps custom schemas to `pl_staging`, `pl_core`, `pl_restricted`, `pl_reporting`, `pl_ops` (plus `<name>_<suffix>` when env `PL_DATASET_SUFFIX` is set, always `drill` for prod-drill). The same schema names exist in DuckDB.

### 11.2 Models and materializations
| Model | Grain / key | Local (DuckDB) | Production (BigQuery) |
|---|---|---|---|
| `stg_events` | event_id | incremental `merge` on `event_id`, insert-only in effect: new raw rows with `_pl_load_seq > max(_pl_load_seq)` in `{{ this }}`, anti-joined on `event_id` against `{{ this }}`, deduplicated within the batch keeping the earliest `received_at` (ties by `delivery_id`), so a later duplicate never overwrites the first delivery and never marks buckets dirty (prototype verified) | same; clustered by source, event_type |
| `stg_hris__worker_events`, `stg_ats__*`, `stg_talent__*` | event_id | view, JSON parsed with `pl_json_str` / `pl_json_int` (DuckDB `json_extract_string`, BigQuery `JSON_VALUE`) | view |
| `int_hris__effective_events` | event_id | table: latest correction by source_sequence applied; rescinded events removed; orphan corrections kept aside with `anomaly_code` | table |
| `int_hris__spells` | employee_id, spell_no | table: total construction; a rehire with an open prior spell closes it provisionally (`is_inferred_end`, anomaly) | table |
| `int_hris__attribute_timeline` | employee_id, valid_from | table | table |
| `dim_employee_history` (SCD2) | employee_id, valid_from | incremental `delete+insert`, unique_key `employee_bucket`; affected buckets from its own cursor `pl_affected_buckets(this)`; rows stamped with `_pl_load_seq` | incremental `insert_overwrite`, `partition_by {field: employee_bucket, data_type: int64, range: {start: 0, end: 2048, interval: 1}}`, cluster employee_id; same cursor |
| `fct_workforce_monthly` (periodic snapshot) | employee_id, month_end | bucketed replace with its own cursor | bucketed replace with its own cursor |
| `fct_compensation_history` (restricted) | employee_id, valid_from | bucketed replace with its own cursor | bucketed replace, policy tag on `base_salary`, `bonus_target_pct` |
| `fct_performance_reviews` (restricted) | review_id | table | table, policy tag on `rating` |
| `dim_employee` | employee_id | table (current row) | table |
| `fct_employment_events` | event_id | table: hires, rehires, terminations, transfers, job changes (effective, corrected) | table |
| `fct_offers` (accumulating snapshot) | offer_id | table | table |
| `dim_date`, `dim_department`, `dim_job`, `dim_location` | natural keys | table (date spine macro: DuckDB `range`, BigQuery `GENERATE_DATE_ARRAY`; both compiled in scratch) | table |
| `metrics_workforce_monthly` | month, department_id (`ALL` = company) | table, 468 rows | table |
| `rpt_workforce_monthly`, `rpt_offer_acceptance_monthly` | month, department_id | view; cells with headcount < 5 nulled | view in `pl_reporting`, `grant_access_to: [{project: <gcp project>, dataset: pl_core<suffix>}]` (authorized view) |
| `ops_delivery_stats`, `ops_event_freshness`, `ops_anomalies` | various | table / incremental append | same |

Per-model bucket cursors (replaces the earlier shared `int_affected_buckets`): `pl_affected_buckets(cursor_relation)` selects the buckets of employees with `stg_events._pl_load_seq > coalesce(max(_pl_load_seq), -1)` in the model's own relation, and each bucketed model stamps its rows with the max `_pl_load_seq` it consumed. A model that failed in attempt 1 keeps its old cursor and catches up in attempt 2 even though upstream models already advanced theirs. Reproduced in scratch on dbt-duckdb: with a shared upstream cursor, a downstream model forced to fail and then rebuilt stayed stale (`[(E001, 10), (E002, 20)]` against full refresh `[(E001, 60), (E002, 20), (E005, 70)]`); with its own cursor it matched the full refresh exactly. Bucket = `mod(cast(substr(employee_id, 2) as int64), 2048)`; incremental runs emit full histories for every employee in an affected bucket, so replacing whole buckets is exact. 2,048 partitions stays under the BigQuery per-table partition limit and the per-job modified-partition limit (both **[UNVERIFIED]**, from memory 10,000 and 4,000).

### 11.2.1 Dimensional model

```mermaid
erDiagram
  dim_employee ||--o{ dim_employee_history : "has SCD2 rows"
  dim_employee ||--o{ fct_employment_events : "has"
  dim_employee ||--o{ fct_workforce_monthly : "snapshotted monthly"
  dim_employee ||--o{ fct_compensation_history : "restricted"
  dim_employee ||--o{ fct_performance_reviews : "restricted"
  dim_department ||--o{ dim_employee_history : "department_id"
  dim_department ||--o{ fct_offers : "requisition department"
  dim_department ||--o{ metrics_workforce_monthly : "department_id or ALL"
  dim_job ||--o{ dim_employee_history : "job_code"
  dim_location ||--o{ dim_employee_history : "location_id"
  dim_date ||--o{ fct_workforce_monthly : "month_end"
  dim_date ||--o{ metrics_workforce_monthly : "month"
  fct_workforce_monthly }o--|| metrics_workforce_monthly : "aggregates to"
  fct_offers }o--|| metrics_workforce_monthly : "aggregates to"
  dim_employee_history {
    string employee_id
    int spell_no
    date valid_from
    date valid_to
    string department_id
    string job_code
    string location_id
    decimal fte
    string employment_status
    bool is_current
    int employee_bucket
  }
  fct_offers {
    string offer_id
    string requisition_id
    string candidate_id
    date extended_date
    date decision_date
    string final_status
    date start_date
    string hired_employee_id
  }
  metrics_workforce_monthly {
    date month
    string department_id
    int headcount
    decimal fte
    int hires
    int rehires
    int departures
    int offers_accepted
    int offers_declined
    decimal offer_acceptance_rate
  }
```

### 11.3 Effective-dated history semantics
- Employment spell `[hire_date, termination_date]` inclusive of the last day worked. A rescinded termination never ends a spell.
- Headcount at month end `m`: employees with `hire_date <= last_day(m)` and (`termination_date is null` or `termination_date > last_day(m)`). Departures in `m`: terminations dated in `m`. This keeps roll-forward exact: `HC(m) = HC(m-1) + hires(m) - departures(m)` for the company, plus `transfers_in(m) - transfers_out(m)` per department.
- `dim_employee_history` rows carry `valid_from`, `valid_to` (exclusive; `9999-12-31` open), `department_id`, `job_code`, `location_id`, `fte`, `employment_status`, `spell_no`, `is_current`, `employee_bucket`. The `pl_employee_as_of(date)` macro gives as-of queries.

### 11.4 The five metrics (`metrics_workforce_monthly`, one definition used everywhere)
| Metric | Definition | Additivity |
|---|---|---|
| headcount | active at month end (section 11.3) | additive across departments, not across months |
| fte | sum of `fte_bp` of those counted in headcount, as `DECIMAL(18,6)` = integer sum times `0.0001` | same |
| hires | hire + rehire spells starting in the month, department at hire (`rehires` also reported) | additive |
| departures | effective terminations in the month, department on the last day | additive |
| offer_acceptance_rate | `offers_accepted / (offers_accepted + offers_declined)` by decision month and requisition department; rescinded excluded; null when the denominator is 0; computed exactly as integer parts per million rounded half up, `pl_int_div(2 * 1000000 * accepted + total, 2 * total)` on INT64 casts, then times `DECIMAL '0.000001'` | ratio |

Components `offers_extended`, `offers_accepted`, `offers_declined`, `transfers_in`, `transfers_out` are stored alongside. No floats anywhere in published models (verified why: DuckDB `DECIMAL / DECIMAL` returns `DOUBLE`, and integer literals overflow INT32 without explicit `BIGINT` casts; both reproduced).

### 11.5 dbt unit tests (`unit_tests:` in YAML, DuckDB in CI only)
Rehire after termination; rescinded termination; hire-date correction across a month boundary; correction arriving before its base event; FTE correction; transfer and termination ordering; two corrections (latest wins); offer accepted then hire with corrected date; bucketed model with `pl_is_incremental` overridden through `overrides.macros` and `this` given (works, verified). They need existing relations, so CI runs `dbt run --empty` before `dbt build`; the runner always excludes them.

Plus one dbt-level orchestration test, `test_bucket_cursors.py` (pytest driving `dbtRunner` on the small profile): load half the data and build; load the rest and build with `PL_FAULT_FAIL_MODEL=fct_workforce_monthly` (fails); rebuild; assert digests equal a `--full-refresh` build.

### 11.6 Reconciliation tests (`tests/reconciliation/`, each returns violating rows)
| Id | Name | Severity | Checks |
|---|---|---|---|
| R1 | `recon_headcount_roll_forward_company` | error | company identity holds every month |
| R2 | `recon_headcount_roll_forward_department` | error | department identity with transfers |
| R3 | `recon_rehire_continuity` | error | rehire spells have `spell_no > 1`, keep `employee_id`, start strictly after the prior spell's effective end, never overlap |
| R4 | `recon_retro_corrections_applied` | error | for every applied correction, history at the corrected date shows the corrected value (independent SQL path vs history) and the superseded value appears nowhere for that range |
| R5 | `recon_rescinded_terminations_excluded` | error | no spell ends at a rescinded termination; departures exclude them |
| R6 | `recon_offer_to_hire` | warn | each accepted offer with `start_date <= data_as_of` has exactly one hire or rehire for its candidate within 30 days; each in-window hire has exactly one accepted offer |
| R7 | `recon_event_counts_vs_manifest` | warn (error-level in `prod verify` at quiescence, which also catches records Basin dropped after a 202) | unique events by source and type equal `expected_event_counts` for `var('pl_profile')` |
| R8 | `recon_no_event_id_conflicts` | error | one `payload_sha256` per `event_id` |
| R9 | `recon_history_contiguity` | error | SCD2 intervals non-overlapping and contiguous within a spell |
| R10 | `recon_metrics_vs_oracle` | warn | all five metrics and components equal the oracle for all 468 rows of `var('pl_profile')` |
| R11 | `recon_anomalies_open` | warn | `ops_anomalies` (orphan corrections, inferred ends, talent events before hire or after termination) is empty |

Error-level checks block a commit. Warn-level checks are completeness checks that may legitimately fail while late data is still in flight; every eval asserts they are 0 at quiescence, and the generator tests prove R6 and R11 are empty on the true world (section 5.3).

### 11.7 BigQuery-specific semantics (production only)
- **Datasets** (created by `bootstrap-gcp`, location US): `pl_raw`, `pl_staging`, `pl_ops` with time travel 48 h; `pl_core`, `pl_restricted`, `pl_reporting` with 168 h; the same six with suffix `_drill` and the same settings. Time travel is set with the pinned client (`Dataset.max_time_travel_hours`, which validates 48..168 and rejected 36 in scratch), not with DDL.
- **Restricted data**: taxonomy `peoplelake-sensitivity` (location `us`, `FINE_GRAINED_ACCESS_CONTROL`) with policy tags `compensation` and `performance`. dbt sets `policy_tags: ["{{ var('pl_pt_compensation') }}"]` on restricted columns with `persist_docs: {columns: true}` (both required per dbt docs; var rendering in `policy_tags` verified via `dbt parse` and the manifest).
- **Data masking**: data policies `pl_mask_compensation` (`DEFAULT_MASKING_VALUE`) and `pl_mask_performance` (`ALWAYS_NULL`) on those tags. `pl-analyst` gets `roles/bigquerydatapolicy.maskedReader`; `pl-runner` gets `roles/datacatalog.categoryFineGrainedReader` because digests need raw values. Dynamic data masking and column-level access control are available on on-demand pricing (verified in the editions table). `peoplelake prod demo-masking` impersonates `pl-analyst` and shows masked values.
- **Authorized views**: `pl_reporting.rpt_*` are views authorized on `pl_core` via dbt `grant_access_to`; analysts need only `roles/bigquery.dataViewer` on `pl_reporting` plus `roles/bigquery.jobUser` (verified roles).
- **Time travel and the restore drill**: after dbt's `CREATE OR REPLACE TABLE`, `FOR SYSTEM_TIME AS OF` still reads the previous version (docs). The documented restore is a copy job (`bq cp table@<epoch_ms> new_table`), but per the docs it does not copy partitioning information or tags to the destination, so a copied `dim_employee_history`, `fct_workforce_monthly` or `fct_compensation_history` would be unpartitioned and unusable by the int64-range `insert_overwrite`. `peoplelake prod drill-restore` therefore restores with SQL into `_drill`: `CREATE OR REPLACE TABLE pl_core_drill.<t> PARTITION BY RANGE_BUCKET(employee_bucket, GENERATE_ARRAY(0, 2048, 1)) CLUSTER BY employee_id AS SELECT * FROM pl_core.<t> FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(<ms>)`, copies the source schema's policy tags onto the restored columns with `Client.update_table(schema)` before reading anything, and passes only when the restored digests equal the digests the ledger recorded for the run committed at that time. `pl_restricted_drill` grants nothing to `pl-analyst`, so an untagged moment never exposes raw values. Fail-safe keeps deleted data 7 more days and is recoverable only through Cloud Customer Care (verified). Whole tables only, not partitions (docs).
- **Recovery path two**: replay from Basin Catalog (`POST /api/replay`); drills replay into `_drill` datasets.

### 11.8 Local versus production SQL differences handled by macros
- From dbt (built in, no package): `dbt.date_trunc`, `dbt.datediff`, `dbt.dateadd`, `dbt.last_day`, `dbt.hash`, all compiled for both engines in scratch. They return engine-specific types (`dbt.date_trunc` gives TIMESTAMP on both; `dbt.dateadd` gives TIMESTAMP on DuckDB and DATETIME on BigQuery), so the repo only calls them through wrappers that cast to DATE: `pl_month_start(d)`, `pl_add_days(d, n)`, `pl_month_end(d)`, `pl_days_between(a, b)`.
- In-repo: `pl_json_str`, `pl_json_int`, `pl_employee_bucket`, `pl_date_spine`, `pl_try_cast` (DuckDB `try_cast`, BigQuery `safe_cast`; `dbt.safe_cast` is a plain cast on DuckDB), `pl_int_div` (DuckDB `//`, BigQuery `DIV`), `pl_bp_to_decimal` (integer basis points to `DECIMAL(18,6)`/`NUMERIC` by multiplication), `pl_ppm_rate`, `pl_is_incremental` (false when `var('pl_offline_compile')`; true when `var('pl_force_incremental_compile')`), `pl_affected_buckets`, `pl_fault_guard`.
- Ordering: every `ORDER BY` and every window `ORDER BY` states `NULLS LAST` explicitly and ends in a total order (`event_id`, then `delivery_id` where deliveries are involved). DuckDB sorts NULLs last for both ASC and DESC (reproduced) while BigQuery sorts them first for ASC. `peoplelake dev lint-sql` (sqlglot over compiled SQL, run in CI) rejects any ORDER BY without an explicit NULLS clause in `warehouse/models`.
- Numerics: no FLOAT64 or DOUBLE in published models (BigQuery float SUM order is nondeterministic); FTE and rates are exact decimals.

### 11.9 Offline BigQuery compile (verified in scratch)
`dbt compile --target bq_offline --no-introspect --no-populate-cache --vars '{pl_offline_compile: true}'` renders BigQuery SQL without credentials (`method: oauth-secrets`, placeholder token). `is_incremental()` needs a live connection, hence `pl_is_incremental`. CI compiles twice: once as above (full-build branch) and once with `--vars '{pl_offline_compile: true, pl_force_incremental_compile: true}'` (incremental branch: cursors, anti-joins, bucket filters). It parses every compiled model with `sqlglot.parse_one(sql, read="bigquery")`, and `test_bq_manifest.py` asserts from the manifest that restricted columns carry `policy_tags` with `persist_docs.columns`, every `rpt_*` view has `grant_access_to`, and the three bucketed models have the int64 range `partition_by` with `insert_overwrite`. `dbt parse --target prod` also works without credentials; `dbt compile` with ADC or a dummy service-account key does not. None of this renders the materialization DDL (MERGE scripts, partition replacement, policy-tag application), so it proves the SQL compiles and parses, not that it runs on BigQuery; the BigQuery drill scenarios are the runtime proof (section 20.5).

## 12. Auth model

- **Production**: Worker-level Cloudflare Access. setup:prod creates the Access application through the API with `destinations: [{type: "worker", worker_id}]`, which the Workers docs say covers the workers.dev hostname, routes and previews (the API field that holds `worker_id` is **[UNVERIFIED]**; fallback: a `self_hosted` app with `domain: peoplelake.<subdomain>.workers.dev`, with previews disabled). Policies: (1) Allow, Emails = Nitish's email; (2) Service Auth (`decision: "non_identity"`), Include = service tokens `pl-source-hris`, `pl-source-ats`, `pl-source-talent`, `pl-runner` by `token_id` (shape from Cloudflare's common-policies docs). The Worker verifies `Cf-Access-Jwt-Assertion` on every request with `createRemoteJWKSet(new URL(ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs"))` and `jwtVerify(token, jwks, {issuer: ACCESS_TEAM_DOMAIN, audience: ACCESS_AUD, algorithms: ["RS256"]})`. The cookie is ignored in production (docs recommend the header). Keys rotate every 6 weeks and old keys stay valid for 7 days (docs); remote JWKS handles `kid` rotation.
- **Strict service token authentication**: Zero Trust organizations created on or after 2026-10-05 have it on and cannot turn it off (Cloudflare changelog, 2026-10-02). Only Service Auth policies authorize token requests, no `CF_Authorization` cookie is issued or honored, and failures are 401/403 rather than a redirect. The design already sends both headers on every machine request and uses a Service Auth policy, so nothing changes; doctor expects 401/403 for a bad token.
- **Principal mapping**: service-token JWTs have `common_name` = the token's Client ID and empty `sub` (verified example); human JWTs have `email`. `ACCESS_ROLE_MAP` maps emails to roles (`viewer`, `operator`) and Client IDs to exactly one of `source:hris`, `source:ats`, `source:talent`, `runner`. A source token can post only to its own source.
- **Local and CI**: `AUTH_MODE=dev`. `peoplelake auth dev-keys` writes an RS256 keypair to `.dev/keys/` and `DEV_ACCESS_JWKS` to `.dev.vars`; tokens use `iss = https://peoplelake-dev.local` and `aud = peoplelake-dev`. The same `verifyAccessJwt` code runs; only the keyset source differs. Vitest generates ephemeral keys in `vitest.config.ts`. PyJWT-minted tokens verified with jose in this session, and a wrong `aud` is rejected.
- **Outbound and cross-cloud credentials**: the Worker holds `GCP_DISPATCHER_KEY` (can only run the Cloud Run job, section 8.3) and `R2_CATALOG_TOKEN` (R2 Admin Read only, for the catalog poll). The Cloud Run Job runs as `pl-runner` (BigQuery through the metadata server, no key) and reads three Secret Manager secrets: the R2 read token and the `pl-runner` service token's Client ID and Secret. GitHub holds no cloud credentials at all.
- **Tests**: missing token 401; bad signature, wrong `iss`, wrong `aud`, expired all 401; wrong role 403; cross-source post 403; dev routes 404 in production config; `AUTH_MODE=dev` with `ENVIRONMENT=production` gives a config error; `ENVIRONMENT=local` with a non-local host gives a config error.

## 13. AI: `AiProvider` and minimal `/api/ask` (above the cut; the eval is below it)
`POST /api/ask {question}` maps a question to a validated `MetricQuery {metric: one of 5, department_id?: D01..D12|ALL, start_month, end_month}`, then answers only from the committed metrics snapshot (numbers never come from the model). `AiProvider` has three implementations behind one interface:
- `workers-ai` (production): `env.AI.run(AI_MODEL, {messages, response_format: {type: "json_schema", json_schema}}, {gateway: {id: AI_GATEWAY_ID}})` through AI Gateway `peoplelake` (created by setup:prod). JSON mode may fail with "JSON Mode couldn't be met", so one repair retry then 422. The runtime types expose `GatewayOptions.id` and `Ai.aiGatewayLogId` (read in the generated types), which `/api/ops/ai` uses to prove the call went through the gateway.
- `openai-compatible` (local): llama-server on `127.0.0.1:8150` (`-np 1 -c 8192 -ngl 99`), `response_format` json_schema.
- `stub` (CI default): deterministic rule parser, labeled as such.

Above the cut: the three providers, `/api/ask`, `ai.test.ts` (mocked `AI` binding asserting model, `response_format` and the gateway option; stub goldens; openai-compatible request shape with injected fetch), AI Gateway creation in setup:prod and the doctor check. Below the cut: `evals/ask/questions.jsonl` (60 hand-written questions) and `peoplelake eval ask`, which reports exact-match and per-field accuracy per provider. A smoke test on 2026-10-10 showed Qwen3-1.7B mapping "Q2 2024" to 2024-02..2024-04, which is why the eval exists.

## 14. Dashboard (below core cut line)
React 19 + Vite 8, built to `web/dist`, served as Workers static assets with `run_worker_first` for `/v1/*`, `/api/*`, `/internal/*`, `/dev/*`. Pages: Overview (freshness p50/p95 over 24 h, last runs), Runs (steps, attempts, durations), Metrics (468-row table plus SVG trend), Checks (error and warn counts per run). Reads only `/api/*`. Until it lands, the README states that v1 has no front end and that `/api/*` is the read interface.

## 15. Test plan

### 15.1 Worker (`test/worker`, workerd via `@cloudflare/vitest-plugin`)
- `config.test.ts`: every fail-closed rule, including the local-host rule and `RUNS_ENABLED` prerequisites.
- `auth.test.ts`: the matrix in section 12 using in-process jose keys.
- `ingest.test.ts`: per-source normalization goldens; 422 all-or-nothing; size limits; `payload_sha256` equals `contracts/golden/canonical-json.json`; non-integer payload numbers rejected; `delivery_id` unique per request; `LakeSink` selection by `LAKE_MODE`.
- `sink-roller.test.ts`: `runInDurableObject` + `runDurableObjectAlarm`: roll on alarm and on max records; crash between put and delete; lake-event message shape.
- `coordinator.test.ts`: single-flight; pending replay wins; run ids carry the generation; `requestRun` calls `get` before `create`; job claim and lease; `shouldDispatch` window; duplicate result returns `duplicate: true` and sends one event; `sendEvent` to a finished instance is caught; lease expiry sends `expired`; claim timeout; watermark and `transformed_through_seq` advance only on commit; commit idempotent; `rewind_watermark` fault.
- `workflow.test.ts` (introspection API verified: `introspectWorkflowInstance`, `mockEvent`, `forceEventTimeout`, `mockStepError`, `waitForStatus`, `getOutput`): happy path; load attempt 1 times out and attempt 2 succeeds; transform fails then succeeds; three failures end in `errored` with the run failed and released; commit step error retried; verify rejects error-level checks; duplicate events for an old attempt are ignored; transform skipped when nothing is new; transform not skipped when `raw_max_load_seq > transformed_through_seq`.
- `dispatcher.test.ts`: Cloud Run: the JWT assertion's header and claims (verified with jose against a generated key), the token request body, the `jobs/{job}:run` URL and empty body, token caching and refresh, 4xx surfaced; poll dispatcher no-op. Injected `fetch`.
- `catalog-poll.test.ts`: loadTable URL and bearer header; append snapshot after the watermark triggers a run; replace-only snapshots do not; poll errors recorded.
- `queue.test.ts`: `createMessageBatch` + `getQueueResult` for lake events, malformed messages acked.
- `ai.test.ts`: mocked `AI` binding (model, `response_format`, `gateway.id`); stub goldens; openai-compatible request shape.
- `api.test.ts`: role gates, dev routes absent in production config, ops routes operator-only.

### 15.2 Node (`test/node`)
Contracts fixtures validate under zod; canonical JSON golden; `render-wrangler` substitutes all placeholders; `predeploy-check` refuses unsafe configs; `config-names.test.ts` asserts the top-level Worker name differs from `env.production.name` and that top-level `workers_dev` is false; `check-prose` catches an em dash in a fixture; `worker-configuration.d.ts` is current (`npm run typegen:check` in CI, which passes with or without a local `.dev.vars`).

### 15.3 Python (`pipeline/tests`)
- Generator: exact counts for both profiles (every row of section 5.2), pinned sha256 per profile, world rules (section 5.3, including hire-date shift bounds, the decision-date rule and comp on true dates), oracle totals (4,000 to 4,650; 2,550 hires; 1,900 departures; 0.833333 acceptance), expected R6 and R11 results empty on both profiles.
- Oracle seeds: regenerated files equal the committed `warehouse/seeds/oracle/*.csv`.
- Contracts: fixtures validate under pydantic; stream schema JSON matches `lake/schema.py` field by field; canonical JSON golden byte for byte.
- Lake: committer idempotent on `(key, etag)`; recommit flag; incremental reads; fallback full scan when the from-snapshot is missing.
- Loader: DuckDB idempotency (load the same batch twice, row count unchanged); BigQuery loader builds the expected SQL and job configs against a fake client.
- Single owner: load, in-process dbt build and digest back to back in one process succeed; a second process cannot open the file meanwhile (documents ADR 0008).
- Time zone: every connection from `open_duckdb` reports `current_setting('TimeZone') = 'UTC'`, and the dbt profile's session does too.
- dbt: `test_bucket_cursors.py` (section 11.5); `test_bq_manifest.py` (section 11.9).
- Digest: canonicalization goldens; column order and row order independence; metadata excluded.
- Dev tokens: claims shape, expiry, `kid`.
- Scenario planner: each scenario's perturbation counts (section 16.1) are exact and deterministic.
- Stack: cleanup leaves 8791, 9241 and 8150 free.
- Bootstrap: `bootstrap_gcp --plan` prints the expected idempotent actions against fake clients; the restore drill SQL parses as BigQuery and carries the range partition and clustering (`test_restore_drill_sql.py`).

### 15.4 dbt
On the small profile loaded straight into DuckDB (no Worker): `dbt seed`, `dbt run --empty`, `dbt build` (models, unit tests, R1 to R11), digests; then `dbt build --full-refresh --exclude-resource-type unit_test`, digests again; both digest sets must be equal and become the CI reference digests. Then the offline BigQuery compiles and `peoplelake dev lint-sql`.

### 15.5 End to end
`e2e` (CI matrix, one leg per scenario B, S1..S5 on the small profile, each from empty state on its own VM): stack up; run the scenario in chunk mode; assert digests equal the reference digests from the dbt job, oracle match and zero warn-level checks at quiescence; stack down.

### 15.6 Resume claim to verification map
| Claim fragment | Verification | Runs where |
|---|---|---|
| three simulated enterprise sources | `test_generator_counts.py::test_three_sources`; ingest routes exist for exactly 3 | CI |
| approximately 100,000 workforce events | generator asserts 100,000; R7 at quiescence on the full profile; `peoplelake prod verify` counts 100,000 unique `event_id` in BigQuery `pl_staging.stg_events` | CI (local), prod after setup |
| into BigQuery | `prod verify` + digest parity DuckDB vs BigQuery; BigQuery drill scenarios | prod only (needs Nitish) |
| Workers, Basin Pipelines, R2 | `doctor` checks stream, sink, pipeline, buckets; `prod verify` reads `peoplelake.raw_events` snapshots | prod only |
| Python/SQL ELT | loader + dbt tests | CI |
| dbt dimensional models | `_core.yml` tests (unique, not_null, relationships) | CI |
| effective-dated employee history | unit tests + R9 | CI |
| five workforce metrics | `test_metric_catalog_has_exactly_five`; R10 oracle | CI |
| reconciliation for rehires | R3 + unit tests | CI |
| reconciliation for retroactive corrections | R4, R5 + unit tests | CI |
| incremental processing | reference digests from the dbt job (incremental-on-empty equals full refresh); every scenario leg equals them; `test_bucket_cursors.py` | CI |
| historical employee records | `dim_employee_history` + `pl_employee_as_of` test | CI |
| consistent workforce reporting | metrics mart is the single definition; reporting views and `/api/*` read it; R10 | CI |
| retry-safe orchestration with Cloudflare Workflows | `workflow.test.ts`, `coordinator.test.ts`, S4 | CI (Miniflare Workflows); prod Workflows after deploy |
| targeting 15-minute p95 freshness | `eval freshness` measured p95 (local); prod p95 from the single `prod:e2e` delivery | local session + prod |
| identical outputs across five scenarios | `eval scenarios` S1..S5 | CI (DuckDB, small), eval-full (DuckDB, full, on demand), BigQuery drill (go-live) |
| replayable | S5 full rebuild + point-in-time replay | CI |

## 16. Evals

### 16.1 Scenario equivalence (`peoplelake eval scenarios --profile full|small --chunks 20|10 [--scenarios B,S1,...] [--target local|prod-drill]`)
Each scenario starts from empty state (wrangler `.wrangler/state` for this repo, local lake, warehouse), uses the same generated dataset, delivers in chunk mode (driver delivers chunk i, forces a sink roll, requests a run, waits for commit), and ends at quiescence. `--target prod-drill` keeps the Worker, Workflows and lake as local stand-ins and points the runner at BigQuery `_drill` datasets (Nitish's ADC impersonating `pl-runner`); its results are labeled `engine: bigquery, orchestration: local`.

| Id | Name | Perturbation (full profile; for the small profile event counts are scaled by 1/10 while run numbers and file counts stay the same) |
|---|---|---|
| B | baseline | each event once, canonical order, batches of 500 |
| S1 | duplicate-client-retries | 10,000 events re-delivered once and 1,000 of them a third time (111,000 deliveries); 30% of duplicates in the same request, 70% at least one chunk later |
| S2 | duplicate-lake-redelivery | faults `rewind_watermark{snapshots: 2}` on runs 3, 6 and 9 (the loader re-reads data it already loaded) and `recommit_sink_files{count: 3}` on run 5 (the committer re-appends 3 committed sink files as new snapshots) |
| S3 | late-arrival | 5,000 events withheld: 3,000 delivered 1 to 3 chunks late, 2,000 after everything else; the withheld set contains exactly 300 corrections, 30 rescinds, 200 terminations, 100 hires and 50 accepted offers; every request is shuffled |
| S4 | recovery-step-failures | faults: run 2 `crash_after_load`, run 4 `fail_transform_model` (`fct_workforce_monthly`, attempt 1), run 5 `duplicate_result`, run 6 `skip_claim`, run 7 `commit_step_error` |
| S5 | recovery-warehouse-rebuild | after a clean delivery: delete the warehouse, reset the watermark, run `replay`; also replay up to run k's `to_snapshot` (k = middle run) into a scratch warehouse (`dataset_suffix: pit`, a separate DuckDB file) and require run k's recorded digests |

Reference: the digests of a straight load of the same profile built with `--full-refresh` (section 15.4). Every scenario, B included, must equal them. Metrics per scenario: digests of the 10 published models; `identical_to_reference` per model; oracle match (468 rows); warn-level counts at quiescence; observed perturbations (duplicates delivered and skipped, late events, faults fired, attempts per job, lease expirations, duplicate results ignored, step retries, transforms skipped). Pass = all five scenarios identical on all 10 models. Output `evals/results/scenarios-<profile>-<engine>-<YYYY-MM-DD>.json` with `engine`, `orchestration`, `lake` and `runner` fields.

### 16.2 Freshness (`peoplelake eval freshness --target local --duration 60m --rate auto`)
- Local live mode: the full profile delivered at a constant rate (`auto` = 100,000 / duration; 27.8 events/s for 60 min) in canonical order; ticker every 60 s; local sink roll 60 s matching the Basin minimum roll interval of 60 s (docs); runs single-flight.
- Per unique event: `freshness = published_at(first committed run with seq >= the run that first loaded it) - first received_at`. `received_at` is the Worker stamp; `published_at` is the commit time, which is no earlier than when dbt made rows visible, so this is conservative.
- Reported: p50, p90, p95, p99, max, share within 15 min, run count, run duration p50/p95, stage breakdown (sink wait, trigger wait, dispatch, load, transform, commit). Also reported excluding the first 5 minutes. The ledger histograms are cross-checked against the `ops_event_freshness` histogram the runner returns in each TransformResult (must agree within 10 s); the eval never opens the warehouse file itself (ADR 0008).
- Production: measured exactly once, from the single live delivery that `npm run prod:e2e` makes (`peoplelake eval freshness --target prod --from-delivery <delivery_run_id>` reads the ledger and BigQuery `ops_event_freshness`; it delivers nothing). The results JSON records `method: "single-live-delivery"` and the delivery id. A second live delivery of the same profile would re-send the same 100,000 event ids: it would time duplicates that change no published row and double the lake and raw table, so `prod:e2e` refuses to run when production already holds events unless `peoplelake prod reset --confirm peoplelake` ran first (runbook `prod-reset.md`).
- The 15-minute number is a target that is reported, never asserted in CI. Local results describe the local stack only.

### 16.3 Oracle accuracy, incremental parity
Both are part of 16.1 and also run standalone: `peoplelake eval oracle`, `peoplelake eval parity` (after `stack down`).

### 16.4 Ask eval (below cut line)
`peoplelake eval ask --provider stub|llama|workers-ai`.

### 16.5 Results policy
README Results contains only numbers from `evals/results/*.json` produced in a session by these commands, each with command, date and engine, rendered by `npm run results:readme`. Nothing is copied from this spec's estimates. Until the BigQuery drill has run, README Status says "identical outputs proven on DuckDB; BigQuery pending".

## 17. CI (`.github/workflows/`, ubuntu-latest, no macOS assumptions, no local SHAs, `env: {TZ: UTC}`, `permissions: {contents: read}`)

`ci.yml` (push and pull_request):
1. `node`: setup-node from `.nvmrc`, `npm ci`, `npm run typegen:check`, `npm run typecheck`, `npx vitest run --project worker --project node`, `npm run deploy:dry-run` (renders with fixture state, `wrangler deploy --env production --dry-run -c wrangler.production.jsonc`), `npm run check:prose`.
2. `python`: setup-uv 10.3.0 with `version: "0.12.17"` and Python 3.12, `uv sync --locked --project pipeline`, `ruff check`, `pytest -m "not e2e"`.
3. `dbt`: generate the small profile, load straight into DuckDB, the sequence in section 15.4 (`dbt run --empty` before the first `dbt build`), `test_bucket_cursors.py`, the two offline BigQuery compiles, sqlglot parse, `test_bq_manifest.py`, `peoplelake dev lint-sql`; uploads `reference-digests-small.json`.
4. `clean-clone`: `peoplelake dev clean-clone-check` clones the checked-out commit into a temp dir and runs `uv sync --locked`, `dbt parse` and `pytest -m smoke` there, so nothing gitignored is ever relied on.
5. `runner-image`: `docker build .` (no push).
6. `e2e` (needs 1 to 3; matrix `scenario: [B, S1, S2, S3, S4, S5]`, `fail-fast: false`): downloads the reference digests, stack up on 8791, runs one scenario on the small profile, uploads its JSON, stack down. `timeout-minutes` is set to twice the time measured for the slowest scenario in the build session (measured before the value is written; never guessed).

`eval-full.yml` (`workflow_dispatch` and a weekly schedule only, never on push): the same matrix on the full profile with `--chunks 20`, plus an optional freshness run (input `freshness_minutes`, default 20) that reports only. Uploads JSON artifacts. Does not commit results. Timeouts set from a measured full-profile scenario.

There is no production workflow in GitHub (ADR 0002). Optional hardening noted for later: pin third-party actions to commit SHAs.

## 18. Local versus production matrix (copied into README)

| Concern | Local (offline, CI) | Production |
|---|---|---|
| Ingest API | wrangler dev 4.149.0 (workerd via Miniflare) on 127.0.0.1:8791, Worker name `peoplelake-local` | Worker `peoplelake` on workers.dev behind Cloudflare Access |
| Stream to lake | **stand-in**: `SinkRoller` DO writes NDJSON roll files to local R2 (Miniflare's Pipeline binding discards data) | Basin Pipelines stream `peoplelake_raw_stream` + pipeline + sink (`r2-data-catalog`, roll 60 s, Parquet zstd) |
| Lake catalog | **stand-in**: pyiceberg 0.12 `SqlCatalog` (SQLite) on disk, committed by `committer.py` | Basin Catalog (Iceberg REST) on R2 bucket `peoplelake-lake` |
| New-data trigger | **stand-in**: SinkRoller enqueues an R2-notification-shaped message on every roll | per-minute cron polls the Basin Catalog REST table metadata for new append snapshots; R2 notifications to Queue `peoplelake-lake-events` as an optimization |
| Orchestration | Workflows as implemented by Miniflare | Cloudflare Workflows |
| Ledger | Coordinator DO (SQLite) in Miniflare | Coordinator DO |
| Runner | `peoplelake runner poll` process | Cloud Run Job `peoplelake-runner` (us-central1), started by the Workflow through the Cloud Run Admin API |
| Warehouse | DuckDB 1.5.6 via dbt-duckdb 1.11.0, session UTC | BigQuery (US) via dbt-bigquery 1.12.1 |
| Load | `INSERT ... WHERE NOT EXISTS` on `delivery_id` | load job (Parquet, free) to stage table + `MERGE` on `delivery_id` |
| Column security | none (schemas only) | policy tags, data masking policies, authorized views |
| Recovery | replay from local Iceberg; Iceberg snapshots | replay from Basin Catalog; BigQuery time travel (48..168 h) with SQL restore into `_drill`; 7-day fail-safe via support |
| Auth | locally generated RS256 keys, same verifier | Access JWT (RS256) against the team JWKS; service tokens for machines |
| LLM | llama-server Qwen3-1.7B on 8150, or the deterministic stub (CI) | Workers AI through AI Gateway `peoplelake` |
| Cron | ticker process | Workers cron `* * * * *` |
| Front end | none in v1 unless the dashboard lands (below the cut) | same |
| Freshness numbers | measured on the local stack | measured once from the `prod:e2e` live delivery |
| Scenario equivalence | DuckDB, every push (small) | BigQuery `_drill` datasets with local orchestration stand-ins, go-live step |

## 19. Local setup (README)
```bash
git clone https://github.com/nitishsjsucs/peoplelake && cd peoplelake
npm ci
uv sync --locked --project pipeline
uv run --project pipeline peoplelake auth dev-keys          # .dev/keys + .dev.vars
npm run doctor -- --local-only
npm test                                                    # vitest (TZ=UTC)
npm run test:py                                             # TZ=UTC uv run --project pipeline pytest
npm run eval:scenarios -- --profile small --chunks 10
npm run eval:scenarios -- --profile full --chunks 20
npm run eval:freshness -- --target local --duration 60m
uv run --project pipeline peoplelake stack down             # always leaves 8791/9241/8150 free
```

npm scripts (`package.json`; every script that runs node, vitest, uv or dbt is prefixed with `TZ=UTC`):
| Script | Command |
|---|---|
| `dev` | `wrangler dev --port 8791 --inspector-port 9241 --ip 127.0.0.1` |
| `typegen` / `typegen:check` | `wrangler types worker-configuration.d.ts --strict-vars=false --env-file .dev.vars.example` / same with `--check` |
| `typecheck` | `tsc -p tsconfig.worker.json && tsc -p tsconfig.node.json` (+ web below the cut) |
| `test` | `vitest run` |
| `test:py` | `uv run --project pipeline pytest` |
| `check:prose` | `node scripts/check-prose.ts` |
| `deploy:dry-run` | render with fixture state, `predeploy-check`, `wrangler deploy -c wrangler.production.jsonc --env production --dry-run` |
| `deploy` | render, `predeploy-check`, `wrangler deploy -c wrangler.production.jsonc --env production --secrets-file <temp file, mode 600>`; the only supported way to deploy |
| `deploy:runner` | `uv run --project pipeline peoplelake prod deploy-runner` (Cloud Build image + `gcloud run jobs deploy`) |
| `setup:prod` | `node scripts/setup-prod.ts` (flags `--only cloudflare\|gcp\|worker`, `--dry-run`) |
| `doctor` | `node scripts/doctor.ts` (flag `--local-only`) then `peoplelake prod doctor-gcp` unless local-only |
| `prod:e2e` | `peoplelake sim deliver --target prod --profile full --scenario baseline --mode live --duration 60m`, then `peoplelake prod verify`, then `peoplelake eval freshness --target prod --from-delivery <id>` |
| `eval:scenarios` / `eval:freshness` | thin wrappers over the `peoplelake eval` commands |
| `results:readme` | `node scripts/results-to-readme.ts` |

Python CLI (`peoplelake`): `generate`, `auth dev-keys`, `auth dev-token`, `lake init|commit|scan|catalog-info`, `sim deliver`, `runner poll|run`, `stack up|down`, `digest`, `dev lint-sql|clean-clone-check`, `eval scenarios|freshness|oracle|parity|ask`, `prod bootstrap-gcp|doctor-gcp|deploy-runner|verify|drill-restore|demo-masking|reset`.

## 20. Production setup Nitish must do

Legend: [V] verified on 2026-10-10 against official docs, the CLI or its source; [U] unverified, doctor checks the result and setup prints the dashboard path if it differs.

### 20.1 Accounts, plans and costs
| Item | Plan | Expected cost | Status |
|---|---|---|---|
| Cloudflare Workers | Workers Paid, required by Basin Pipelines | $5/month minimum; includes 10M requests, 30M CPU ms | [V] |
| Basin Pipelines | included with Workers Paid | ingest free; 50 GB/month processing and 50 GB/month delivery included | [V] |
| R2 | R2 subscription with a payment card (Basin Catalog requires it) | free tier 10 GB-month, 1M Class A, 10M Class B; this project uses well under that | [V] |
| Basin Catalog | with R2 | 1M catalog ops/month included (the catalog poll uses about 43,200), then $9.00/M; compaction 10 GB included | [V] |
| Queues, Workflows, Durable Objects | Workers Paid | 1M queue operations; 500,000 Workflow steps and 1 GB-month (billing started 2026-08-10); 1M DO requests and 5 GB-month | [V] |
| Workers AI | any | 10,000 neurons/day free | [V] |
| AI Gateway | any | core features free | [V] |
| Zero Trust Access | Free plan (up to 50 users) | $0 | [V] price; whether signup asks for a card [U] |
| BigQuery | billing account required (the sandbox does not support DML, and dbt incremental needs MERGE) | on-demand $6.25/TiB after 1 TiB/month free; 10 GiB storage free; batch loads free; at least 10 MB billed per referenced table per query. Estimate: 1 to 2 GB per transform (about 100 queries at the minimum), about 50 transforms for `prod:e2e` and about 70 for the BigQuery drill, so roughly 0.1 to 0.25 TiB in the go-live month; heartbeats run no dbt; every query capped at 5 GB by `maximum_bytes_billed` | [V] prices; volume is an estimate until measured |
| Cloud Run Jobs | instance-based billing, minimum 1 minute per execution | 1 vCPU and 2 GiB for 1 to 3 minutes is under $0.01 per execution at list price; about 150 executions in the go-live month and about 120 heartbeat executions a month after | [V] billing model; free-tier figures for jobs [U] |
| Cloud Build | default pool e2-standard-2 | 2,500 build-minutes/month free; one build per runner deploy | [V] |
| Artifact Registry | one Docker repo, cleanup keeps 3 images | cents per month for about 0.5 GB [U] | [U] |
| Secret Manager | 3 secrets | free tier covers 6 active versions and 10,000 accesses/month | [V] |
| GitHub Actions | CI only, public repo, standard runners | $0 | [U] from general knowledge |
| **Total** | | about $5/month (Workers Paid) plus cents while idle | |

### 20.2 The only steps that need a human (in order)
Cloudflare dashboard (dash.cloudflare.com):
1. Workers & Pages, Plans: subscribe to **Workers Paid** [V requirement].
2. R2 Object Storage: enable R2 and add a payment card [V requirement; exact screen U].
3. Zero Trust (one.dash.cloudflare.com): create the organization and choose a team name on the **Free** plan; the team domain is `https://<team>.cloudflareaccess.com` [V format]. Organizations created now have strict service token authentication on; the design is compatible [V].
4. R2, Overview, **Manage API tokens**, **Create API token** twice [V path]: `peoplelake-sink` with **Admin Read & Write** (the sink needs it) and `peoplelake-catalog-read` with **Admin Read only** [V]. Save as `PL_R2_SINK_TOKEN` and `PL_R2_CATALOG_TOKEN` in `.prod/secrets.env`.
5. My Profile, **API Tokens**, **Create Custom Token** `peoplelake-setup`, scoped to this account, with **Access: Apps and Policies**, **Access: Service Tokens** and **AI Gateway**, each at the edit level (the API reference names them Access: Apps and Policies Write, Access: Service Tokens Write and AI Gateway Write) [V names from the API reference; dashboard labels U]. Save as `PL_CF_SETUP_TOKEN`. Do not name it `CLOUDFLARE_API_TOKEN`: wrangler would then use it instead of the OAuth login. It is needed because wrangler 4.149's OAuth login requests no Access or AI Gateway scopes, and `wrangler login --scopes` only accepts wrangler's own list [V wrangler source].
6. If the account has no workers.dev subdomain, choose a name and put it in `.prod/config.env` as `PL_WORKERS_SUBDOMAIN`; setup registers it (Workflows cannot deploy without one) [V].

Cloudflare CLI:
7. `npx wrangler login`, then `npx wrangler whoami` and put the Account ID in `.prod/config.env` as `PL_CF_ACCOUNT_ID` [V].

Google Cloud:
8. `brew install --cask gcloud-cli` [V cask 587.0.0], then `gcloud auth login`.
9. Create a billing account in the console if there is none (needs a card).
10. In this order [V syntax; order matters so ADC gets a quota project]:
    ```bash
    gcloud projects create peoplelake-<suffix> --name="PeopleLake"
    gcloud billing projects link peoplelake-<suffix> --billing-account=<BILLING_ACCOUNT_ID>
    gcloud config set project peoplelake-<suffix>
    gcloud auth application-default login
    gcloud auth application-default set-quota-project peoplelake-<suffix>
    ```
    Without the last command, ADC calls to APIs such as Data Catalog and BigQuery Data Policy fail with quota-project errors.
11. Use a project without a parent organization (a personal Gmail account has none), or an organization that does not enforce `iam.managed.disableServiceAccountKeyCreation`; organizations created on or after 2024-05-03 enforce it by default [V]. doctor checks this before setup creates the dispatcher key.

Config and run:
12. Fill `.prod/config.env`: `PL_CF_ACCOUNT_ID`, `PL_WORKERS_SUBDOMAIN`, `PL_ACCESS_TEAM_DOMAIN`, `PL_OWNER_EMAIL`, `PL_GCP_PROJECT`, `PL_GCP_REGION=us-central1`, `PL_BQ_LOCATION=US`. Setup sets both `.prod` files to mode 600 and refuses to continue if it cannot.
13. `npm run setup:prod -- --dry-run`, then `npm run setup:prod` (section 21.1; it creates everything else, including the four Access service tokens, the Access application and its AUD, the AI Gateway, all GCP resources, the runner image and job, and both Worker deploys).
14. `npm run doctor` until every check passes; each failure prints the exact command or dashboard step.
15. The go-live sequence in 20.5.
16. GitHub: push `main` so CI runs. CI needs no secrets or variables.

### 20.3 What Nitish never has to do by hand
Create service tokens, copy an AUD tag, create an Access application or policy, create buckets, queues, streams, sinks or pipelines, create a GitHub token, set GitHub secrets, create service accounts, datasets, policy tags or data policies, build an image or deploy a Worker. setup:prod does all of it idempotently.

### 20.4 Files setup writes (all gitignored, mode 600)
`.prod/state.json` (resource ids, catalog URI, warehouse, REST prefix, Access app id and AUD, stream id), `.prod/secrets.env` (adds the four service tokens' Client IDs and Secrets), `.prod/gcp.json` (SA emails, tag and policy names, image digest), `.prod/gcp-dispatcher-key.json`. doctor warns if any is group- or world-readable and never prints values, only names.

### 20.5 Go live and verify
```bash
npm run doctor
npm run prod:e2e                     # one live 60-minute delivery of the full profile, prod verify, and the production freshness measurement
uv run --project pipeline peoplelake eval scenarios --profile small --chunks 10 --target prod-drill   # required: all five scenarios on BigQuery _drill datasets
uv run --project pipeline peoplelake prod demo-masking
uv run --project pipeline peoplelake prod drill-restore
npm run results:readme               # adds the prod and BigQuery numbers with command, date and engine
```
`prod verify` requires exactly 100,000 unique events in `pl_staging.stg_events`, R7 at 0 (error-level here, so records Basin accepted and then dropped are caught), the Basin pipeline's dropped-record metrics at 0 (GraphQL analytics; dataset name **[UNVERIFIED]**, reported as "could not check" if absent), and digests equal to the local full-profile reference digests. The BigQuery drill takes an estimated 1.5 to 3.5 hours (about 70 dbt builds); it can run one scenario at a time with `--scenarios`.

## 21. `setup:prod` and `doctor`

### 21.1 `npm run setup:prod` (`scripts/setup-prod.ts`, idempotent, `--dry-run` prints every command and API call with secrets redacted)
Reads `.prod/config.env` and `.prod/secrets.env`, writes `.prod/state.json`. Each step is check-then-create. Secret values are passed on stdin or in temp files with mode 600, never in argv.
1. Preflight: tool versions; `.prod` file modes; `wrangler whoami`; `gcloud` installed, logged in, ADC present with `quota_project_id` equal to `PL_GCP_PROJECT`; required keys present.
2. workers.dev subdomain: `GET /accounts/{id}/workers/subdomain` with the token from `wrangler auth token --json`; if none, `PUT` with `PL_WORKERS_SUBDOMAIN`. wrangler does the same interactively, and its OAuth scope `workers_scripts:write` covers subdomains [V wrangler source].
3. `wrangler r2 bucket create peoplelake-lake` and `peoplelake-reports` if absent (default jurisdiction; Basin Catalog does not support others [V]).
4. `wrangler basin catalog get peoplelake-lake`; if not enabled, `wrangler basin catalog enable peoplelake-lake`; parse Catalog URI and Warehouse (output format **[U]**; overridable with `PL_R2_CATALOG_URI` and `PL_R2_WAREHOUSE`); `peoplelake lake catalog-info --target prod` records the REST prefix.
5. `wrangler basin catalog snapshot-expiration enable peoplelake-lake --token $PL_R2_SINK_TOKEN --older-than-days 7 --retain-last 50` and `wrangler basin catalog compaction enable peoplelake-lake --target-size 128 --token $PL_R2_SINK_TOKEN` [V syntax from docs].
6. `wrangler queues create peoplelake-lake-events` and `peoplelake-lake-events-dlq`.
7. `wrangler pipelines streams get peoplelake_raw_stream --json`, else `wrangler pipelines streams create peoplelake_raw_stream --schema-file infra/cloudflare/stream-schema.json --http-enabled false` (record the stream id) [V flags].
8. Sink, else `wrangler pipelines sinks create peoplelake_raw_sink --type r2-data-catalog --bucket peoplelake-lake --namespace peoplelake --table raw_events --catalog-token $PL_R2_SINK_TOKEN --roll-interval 60 --compression zstd` [V flags in 4.149; docs now name the type `basin-catalog` and say `r2-data-catalog` still works].
9. Pipeline, else `wrangler pipelines create peoplelake_raw_pipeline --sql-file infra/cloudflare/pipeline.sql` [V flags].
10. `wrangler r2 bucket notification create peoplelake-lake --event-type object-create --queue peoplelake-lake-events --suffix .metadata.json --description "peoplelake iceberg commits"` [V flags; optimization only].
11. Access service tokens with `PL_CF_SETUP_TOKEN`: list by name; create missing ones with `POST /accounts/{id}/access/service_tokens {name, duration: "8760h"}` and save `client_id` and `client_secret` (shown once) to `.prod/secrets.env` [V endpoint, permission, response fields]. If a token exists but its secret is not on disk, rotate it [U rotate endpoint] and save.
12. AI Gateway with `PL_CF_SETUP_TOKEN`: `POST /accounts/{id}/ai-gateway/gateways {id: "peoplelake", cache_invalidate_on_update: true, cache_ttl: 0, collect_logs: true, rate_limiting_interval: 0, rate_limiting_limit: 0}` if absent [V endpoint, permission AI Gateway Write].
13. First deploy (only while no Access application exists): render with `ACCESS_AUD=pending` and `RUNS_ENABLED=false`, `predeploy-check`, deploy with `--secrets-file` (`R2_CATALOG_TOKEN`). Every request returns 401 (fail closed) and no run can start.
14. Access application with `PL_CF_SETUP_TOKEN`: `POST /accounts/{id}/access/apps` `{type: "self_hosted", name: "peoplelake", destinations: [{type: "worker", worker_id}], policies: [allow email PL_OWNER_EMAIL, {decision: "non_identity", include: [{service_token: {token_id}} x4]}]}` [V endpoint, permission, worker destination, non_identity and token_id shapes; worker_id lookup U, hostname fallback]. Read the AUD from the response or `GET` of the app.
15. `peoplelake prod bootstrap-gcp` (section 21.2).
16. Final deploy: render with the real AUD, the role map built from the four Client IDs, and `RUNS_ENABLED=true` only if step 15 passed; `predeploy-check`; deploy with `--secrets-file` (`GCP_DISPATCHER_KEY`, `R2_CATALOG_TOKEN`).
17. `npm run doctor -- --quick`.
Flags: `--only cloudflare` (2 to 14), `--only gcp` (15), `--only worker` (16). `npm run deploy` is step 16 alone; `npm run deploy:runner` rebuilds the image and updates the job.

### 21.2 `peoplelake prod bootstrap-gcp` (Python clients + gcloud, idempotent, `--plan`)
1. Check project, billing enabled (`gcloud billing projects describe`), ADC quota project, and the effective `iam.managed.disableServiceAccountKeyCreation` policy when the project has an organization.
2. `gcloud services enable bigquery.googleapis.com bigquerystorage.googleapis.com datacatalog.googleapis.com bigquerydatapolicy.googleapis.com iam.googleapis.com iamcredentials.googleapis.com cloudresourcemanager.googleapis.com run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com`.
3. Datasets (location US): `pl_raw`, `pl_staging`, `pl_core`, `pl_restricted`, `pl_reporting`, `pl_ops` and the six `_drill` twins, time travel set through `Dataset.max_time_travel_hours` (section 11.7), labels.
4. Taxonomy and policy tags (`PolicyTagManagerClient`), data policies (`DataPolicyServiceClient`, `DATA_MASKING_POLICY`).
5. Service accounts and roles:
   - `pl-runner`: project `roles/bigquery.jobUser`; `roles/bigquery.dataOwner` on all twelve datasets (pre-creating the drill datasets means it never needs `create schema`); `roles/datacatalog.categoryFineGrainedReader` on both tags; `roles/datacatalog.viewer` on the taxonomy (doctor runs `testIamPermissions` for `datacatalog.taxonomies.get` and `bigquery.tables.setCategory` [U exact need]); `roles/secretmanager.secretAccessor` on the three secrets.
   - `pl-analyst`: project `roles/bigquery.jobUser`; `roles/bigquery.dataViewer` on `pl_reporting` and `pl_restricted` (not on drill datasets); `roles/bigquerydatapolicy.maskedReader` on both data policies.
   - `pl-dispatcher`: `roles/run.jobsExecutor` on job `peoplelake-runner` only [V role contents]; one JSON key written to `.prod/gcp-dispatcher-key.json` (mode 600), never re-created while it exists and works.
   - The caller (Nitish): `roles/iam.serviceAccountTokenCreator` on `pl-runner` and `pl-analyst` (drills and the masking demo impersonate them).
   - Cloud Build's default service account (`gcloud builds get-default-service-account`; new projects use the Compute Engine default service account, which organizations created after 2024-05-03 no longer auto-grant Editor) [V change]: `roles/artifactregistry.writer` on the repo, `roles/logging.logWriter`, `roles/storage.objectViewer` on the `<project>_cloudbuild` bucket [U minimal set; doctor runs a build].
6. Secret Manager secrets `pl-r2-catalog-token`, `pl-runner-client-id`, `pl-runner-client-secret`, values piped from `.prod/secrets.env`; a new version only when the value changed.
7. Artifact Registry repo `peoplelake` (docker, us-central1) with a cleanup policy keeping 3 images.
8. `gcloud builds submit --config infra/gcp/cloudbuild.yaml --substitutions _IMAGE=us-central1-docker.pkg.dev/<project>/peoplelake/runner:<git sha>` (refuses a dirty working tree).
9. `gcloud run jobs deploy peoplelake-runner --image <image> --region us-central1 --service-account pl-runner@<project>.iam.gserviceaccount.com --tasks 1 --max-retries 0 --task-timeout 45m --cpu 1 --memory 2Gi --set-env-vars TZ=UTC,PL_TARGET=prod,PL_PROFILE=full,PL_WORKER_URL=https://peoplelake.<subdomain>.workers.dev,PL_GCP_PROJECT=<project>,PL_BQ_LOCATION=US,PL_R2_CATALOG_URI=...,PL_R2_WAREHOUSE=...,PL_PT_COMPENSATION=...,PL_PT_PERFORMANCE=... --set-secrets PL_R2_CATALOG_TOKEN=pl-r2-catalog-token:latest,PL_CF_ACCESS_CLIENT_ID=pl-runner-client-id:latest,PL_CF_ACCESS_CLIENT_SECRET=pl-runner-client-secret:latest --args runner,run,--until-idle,15,--target,prod --labels git-sha=<sha>` [V flags in the gcloud reference].
10. Write `.prod/gcp.json`.

### 21.3 `npm run doctor` (`scripts/doctor.ts` plus `peoplelake prod doctor-gcp`)
Prints PASS, FAIL, MISSING or UNKNOWN per check, and for every non-pass the exact command or console step from section 20:
- Local: node >= 22.18, npm, uv 0.12.x, Python 3.12, wrangler 4.149.0 from `node_modules`, `TZ=UTC` in scripts, ports 8791/9241/8150 free, `.dev.vars` and dev keys, llama-server binary and GGUF (optional).
- Secrets on disk: `.prod/*` mode 600; names present; values never printed.
- Cloudflare: logged in, account id, workers.dev subdomain registered, Workers Paid (PASS only when a paid-only resource such as the Basin stream exists, otherwise UNKNOWN "could not confirm plan"), buckets, catalog enabled, REST prefix recorded, stream, sink, pipeline, queues, notification rule, Worker deployed (`wrangler deployments list`), secrets present (`wrangler secret list`, names only), `RUNS_ENABLED`, Access active (unauthenticated `GET /v1/health` is answered by Access, not the Worker), each service token gets the right role from `/v1/health/auth` and a wrong secret gets 401/403, `/api/ops/lake` shows the catalog poll working and both signals (catalog snapshot and last R2 notification), `/api/ops/ai` shows a gateway log id, `/api/ops/dispatch` mints a token (`--with-dispatch` also starts one execution).
- Google Cloud: gcloud installed, login, ADC with the right quota project, project, billing enabled, APIs enabled, key-creation policy, SAs and roles (`testIamPermissions`), datasets including drill twins and their time travel settings, taxonomy, tags, data policies, secrets, Artifact Registry repo, job image label equals the local HEAD (warns when stale), last execution status, and the last run's billed bytes from `region-us.INFORMATION_SCHEMA.JOBS_BY_PROJECT`.
- Go-live evidence: results files exist for `prod:e2e` freshness and the BigQuery drill; otherwise it prints the commands in 20.5.

## 22. Claims that need Nitish
1. **"into BigQuery" and "Integrated BigQuery"**: until Nitish completes section 20 and runs `npm run prod:e2e`, the BigQuery path is only compiled and parsed offline. After it, `prod verify` must show exactly 100,000 unique events in BigQuery and digests equal to the local reference.
2. **"using Cloudflare Workers, Basin Pipelines, and R2"**: Basin Pipelines and Basin Catalog run only in production; locally they are stand-ins. True in practice after deploy plus `prod:e2e`. Interviewers may know the product by its former name, Cloudflare Pipelines (docs: "formerly known as Cloudflare Pipelines").
3. **"targeting 15-minute p95 data freshness"**: the local number measures the local stack. The production p95 comes from the one live `prod:e2e` delivery and includes the 60 s minimum roll, the catalog poll, Cloud Run start and BigQuery job latency. Nitish should know the measured value before an interview; if it exceeds 15 min, "targeting" is still accurate but he should say what was measured.
4. **"Cloudflare Workflows"**: CI exercises Miniflare's implementation of Workflows; production Workflows behavior (timing, retries) is exercised only after deploy.
5. **"identical warehouse outputs across five scenarios"**: proven on DuckDB in CI. The BigQuery drill (`eval scenarios --target prod-drill`) is a required go-live step; until it runs, README Status says "identical outputs proven on DuckDB; BigQuery pending". The drill keeps the Worker, Workflows and lake as local stand-ins and says so in its results.
6. **Production compute**: the runner is a Cloud Run Job, not GitHub Actions (ADR 0002). He should be able to explain why.
7. **Authorship**: commits are authored as nitishsjsucs with no co-author trailer, by his decision; he must be able to explain the Worker, the Workflow retry model, the per-model bucket cursors and the digest method in an interview.

## 23. Commit plan (git identity set in this repo only; no `Co-Authored-By` trailer; no push)

Before the first commit: `git init -b main`, `git config user.name "nitishsjsucs"`, `git config user.email "227862909+nitishsjsucs@users.noreply.github.com"`. README is written in commit 1 and updated in every commit that changes what works, because the repo is published continuously. Build order puts the data core first: R10 must match the oracle exactly across 468 rows on the small profile before any orchestration exists.

1. `chore: scaffold repo with README, SPEC, CONTEXT, license, tsconfigs, typegen and prose check`
2. `feat(generator): deterministic synthetic world with exact counts, oracle, committed oracle seeds`
3. `feat(contracts): JSON schemas, fixtures and canonical JSON golden shared by Worker and runner`
4. `feat(warehouse): DuckDB loader with single-owner UTC connections and canonical digests`
5. `feat(dbt): staging, spells, effective-dated history with per-model bucket cursors, unit tests`
6. `feat(dbt): five metrics and reconciliation checks matching the oracle on the small profile`
7. `feat(dbt): BigQuery configs, offline compiles, SQL lint, manifest assertions, BigQuery loader`
8. `feat(lake): local Iceberg committer and incremental reader with Basin catalog config`
9. `feat(worker): config, Access JWT verification with dev keys, roles`
10. `feat(ingest): three source envelopes, RawRecord normalization, Basin and local sinks`
11. `feat(orchestration): Coordinator DO, WarehouseRunWorkflow, poll and Cloud Run dispatchers, catalog poll, lake events, cron`
12. `feat(runner): job runner with in-process dbt and local stack manager with process cleanup`
13. `feat(eval): scenario planner and equivalence eval for five scenarios`
14. `ci: node, python, dbt, clean clone, runner image and scenario matrix workflows`
15. `feat(eval): live freshness eval and results renderer; record local results`
16. `feat(ai): AiProvider with stub, llama-server and Workers AI via AI Gateway; minimal /api/ask; ops checks`
17. `feat(prod): runner image, production env, setup:prod, doctor, bootstrap-gcp, drills, reset`
18. `docs: production setup, local versus production matrix, ADRs, runbooks`

**Core cut line.** Everything above is required for the resume text and the production path. Below is optional:

19. `feat(eval): 60-question ask eval across providers`
20. `feat(web): React dashboard served as Worker static assets` (until then the README says there is no front end)
21. `feat(semantic): MetricFlow semantic models and parity test against the metrics mart`
22. `docs: refresh Results`

## 24. Risks
1. **Freshness in production** has floors: the 60 s minimum sink roll (docs), unknown Basin commit latency, the catalog poll (up to 60 s), Cloud Run execution start **[UNVERIFIED]** and BigQuery job latency. Mitigations: catalog poll instead of relying on notifications, one execution drains both jobs, dispatch suppressed while a runner is alive.
2. **R2 notifications for Basin-written objects** are unverified; they are an optimization only and doctor reports both signals.
3. **Basin naming drift**: docs call the sink type `basin-catalog` and use `wrangler basin pipelines ...`; wrangler 4.149 accepts `pipelines` and `basin pipelines` and offers only `r2` and `r2-data-catalog` types. Setup uses the forms 4.149 accepts.
4. **Sink-created Iceberg schema types** (timestamp unit and zone) are unverified; the reader casts to the canonical schema and a prod smoke test checks it.
5. **BigQuery runtime differences** are not caught offline (MERGE behavior, `insert_overwrite` on int64 range partitions, partition limits, policy-tag application). The BigQuery drill scenarios are the runtime proof and run before any resume claim relies on BigQuery.
6. **No atomic multi-table publish**: readers of `pl_core` can see a partially updated set during a run; the committed metrics snapshot and reporting views are the supported read paths.
7. **Snapshot expiration** can remove the watermark snapshot; the reader falls back to a full scan (idempotent, more bytes).
8. **Local Workflows quirk**: in this session wrangler dev logged "Worker's code had hung" around a `waitForEvent`/`sendEvent` exchange while the instance still completed; tests rely on status, not logs.
9. **Logs**: the runner logs counts only. Data is synthetic.
10. **Secrets sprawl**: 4 service tokens, 2 R2 tokens, 1 Cloudflare setup token, 1 GCP dispatcher key. All live in `.prod/*` (mode 600, gitignored) and in Worker or Secret Manager secrets; `docs/runbooks/rotate-tokens.md`; doctor warns on file modes and on expiry where an API exposes it.
11. **Scope**: the core is 18 commits; the cut line protects the resume claims if time runs short.
12. **Version churn**: TypeScript 7 and vitest 5 are out; v1 pins TypeScript 6.0.3 and vitest 4.1.11 to match proven sibling repos.
13. **Cost surprises**: BigQuery bills at least 10 MB per referenced table per query; heartbeats skip dbt, unit tests never run in prod, every query is capped by `maximum_bytes_billed`, and doctor prints the last run's billed bytes.
14. **Service account key creation blocked** by an organization policy. Fallback **[UNVERIFIED end to end]**: a Workload Identity Federation OIDC provider with an uploaded JWKS (`gcloud iam workload-identity-pools providers create-oidc ... --jwk-json-path`, flag verified in the gcloud reference) where the Worker signs its own assertion, exchanges it at STS and impersonates `pl-dispatcher`. Simplest remedy: use a project with no organization.
15. **Access worker destination**: the API field that supplies `worker_id` is unverified; setup falls back to a hostname application with previews disabled, and doctor proves Access answers before the Worker does.
16. **Production reset** needs the sink-created Iceberg table dropped and recreated; whether Basin Catalog allows a REST drop is **[UNVERIFIED]**; the runbook falls back to a new table name.
17. **Cloud Build permissions** on new projects: the minimal role set for the default build service account is unverified; bootstrap grants the documented roles and doctor runs a build.
18. **In-process dbt over a long local poll loop** may grow memory; the local runner restarts itself after 200 jobs. Cloud Run executions are short-lived.
19. **BigQuery drill duration** (estimate 1.5 to 3.5 hours) is long but runs once and can be split by scenario.

## 25. Verification log (2026-10-10)
| Fact | How |
|---|---|
| Product names: Basin Pipelines (formerly Cloudflare Pipelines), Basin Catalog (formerly R2 Data Catalog), both GA | developers.cloudflare.com/pipelines and /r2/data-catalog pages |
| Pipelines on Workers Paid; pricing (ingest free; 50 GB processing and delivery included) | /pipelines and /pipelines/platform/pricing |
| Limits: 20 streams, 20 sinks, 20 pipelines per account; 5 MB per ingestion request | /pipelines/platform/limits |
| Sinks: exactly-once; Basin sink roll default 300 s, minimum 60 s; Parquet only; auto-creates table; cannot target existing tables; token needs R2 Admin Read & Write | /pipelines/sinks and the Basin Catalog sink page |
| Stream schema format and types; invalid records dropped; schema immutable | /pipelines/streams/manage-streams |
| Binding key `stream`, `send(records)` | /pipelines/streams/writing-to-streams |
| Pipeline SQL `INSERT INTO sink SELECT ... FROM stream` | basin-pipelines SQL reference |
| wrangler 4.149.0 commands and flags (pipelines, basin, catalog, notifications, queues, workflows) | ran `--help` in a scratch install |
| Miniflare Pipeline binding `send()` is a no-op; Workflows binding supports `sendEvent`; an Access identity binding exists | read `node_modules/miniflare/dist/src/workers/*` |
| Workflow `waitForEvent` + `mockEvent`, DO SQLite idempotent claim, R2 `onlyIf If-None-Match: *` returns null on second put (Miniflare only; not relied on), pipeline send no-op | scratch Worker + vitest-plugin 1.4.0 + vitest 4.1.11: 2 tests passed |
| `wrangler dev` offline on 8791/9241; cron via `/cdn-cgi/handler/scheduled`; queue consumer; Workflow status complete after `sendEvent` | scratch run, processes killed, ports confirmed free |
| `ai` binding blocks offline `wrangler dev` | scratch run never became ready without login |
| `wrangler types` and `deploy --dry-run --env production` offline | scratch |
| Workflows: free and paid availability; paid includes 500,000 steps and 1 GB-month; event payload 1 MiB; waitForEvent default 24 h, max 365 days; event types without periods; early events buffered | /workflows/reference/pricing, /limits, /build/events-and-parameters |
| Queues pricing and retention | /queues/platform/pricing |
| R2 pricing and free tier; Basin Catalog pricing and payment card requirement; no non-default jurisdiction | /r2/pricing, /basin-catalog/platform/pricing, /basin-catalog/manage-catalogs |
| Basin Catalog: wrangler enable, token permissions, vended SigV4 credentials, compaction and snapshot expiration commands, default expiration 30 days and 5 kept | /basin-catalog/manage-catalogs, /get-started, /table-maintenance |
| R2 event notifications: flags, message fields, 100 rules per bucket | /r2/buckets/event-notifications + wrangler help |
| Access JWT: header, certs URL, RS256, iss and aud, rotation; service token `common_name` = Client ID, empty `sub`; Service Auth action; Worker-level Access steps and coverage | Cloudflare One docs pages + /workers/configuration/cloudflare-access |
| Zero Trust free up to 50 users | cloudflare.com Access pricing pages (via search) |
| Workers Paid $5 minimum; DO SQLite pricing | /workers/platform/pricing |
| Workers AI free 10,000 neurons/day, $0.011 per 1,000 neurons, model prices; JSON mode request shape and supported models | /workers-ai/platform/pricing, /features/json-mode |
| AI Gateway default gateway auto-created; create endpoint and body; core features free | /ai-gateway pages + API reference |
| BigQuery sandbox lacks DML; on-demand includes column-level access control and dynamic masking; masking rule types and roles; authorized view roles; time travel 2..7 days and table-level restore; fail-safe 7 days via support; pricing figures | docs.cloud.google.com pages; pricing via official-domain search results |
| dbt-bigquery `grant_access_to`, `policy_tags` with `persist_docs`, strategies merge/insert_overwrite/microbatch only | docs.getdbt.com bigquery-configs + dbt-bigquery macro source |
| dbt-core 1.12.5 + dbt-duckdb 1.11.0 + dbt-bigquery 1.12.1 + dbt-metricflow 0.15.0 resolve and run together | uv scratch project: `dbt --version`, `dbt build` (merge incremental, tests), `mf query` |
| Offline BigQuery compile recipe and its limits | scratch: oauth-secrets works; ADC and dummy key fail; `is_incremental()` needs a connection |
| `var()` renders inside `policy_tags`; DuckDB tolerates `policy_tags` + `persist_docs` | scratch `dbt parse` manifest and DuckDB build |
| pyiceberg SqlCatalog append with snapshot properties, `incremental_append_scan` signature, APPEND-only filter | scratch + pyiceberg source |
| Data policy enums and taxonomy policy types; time travel validation 48..168 | scratch imports of the Google client libraries |
| PyJWT RS256 tokens verify under jose; wrong aud rejected | scratch cross-language test |
| llama-server JSON-schema output with Qwen3-1.7B on 8150 | scratch run, then killed and port confirmed free |
| (revision 1, no longer used after ADR 0002 changed) GitHub dispatch returns 200 with `workflow_run_id`; fine-grained permission Actions write | docs.github.com REST pages |
| (revision 1, no longer used after ADR 0002 changed) google-github-actions/auth v3 and WIF commands | raw README from the action's repo |
| Action versions; Node LTS 24.21.0; gcloud cask 587.0.0; repo is public and empty | `gh api`, nodejs.org index, `brew info`, `gh repo view` |
| `wrangler types` reads `.dev.vars` and adds names to `Env` and `ProcessEnv`; types generated with `.dev.vars` fail `--check` without it; `--env-file .dev.vars.example` passes `--check` with and without `.dev.vars` (also with extra keys) | scratch wrangler 4.149.0, exit codes checked |
| Plain `wrangler deploy` on a config with environments only warns and targets the top-level name | scratch `--dry-run` |
| wrangler login default scopes include workers, queues, pipelines and ai but no `access:*` or `aig:*`; `--scopes` is validated against that list; `wrangler auth token` prints the OAuth token; subdomain registration and "You need to register a workers.dev subdomain before deploying Workflows" | `wrangler-dist/cli.js` source (DefaultScopes, validateScopeKeys, auth token handler, registerSubdomain) |
| TS 6.0.3: `types` defaults to `[]` (TS2591), `.ts` imports need `allowImportingTsExtensions` (TS5097); the section 3.1 node config passes; `erasableSyntaxOnly` rejects enums (TS1294); Node 25.9 strip-only throws on an enum; worker config with `types: []` and the generated d.ts passes | scratch `tsc` and `node` |
| Unit test on an incremental model fails on an empty DuckDB ("Not able to get columns for unit test"); `--exclude-resource-type unit_test` passes; `dbt run --empty` then `dbt build` passes | scratch dbt-core 1.12.5 + dbt-duckdb 1.11.0 |
| DuckDB session zone defaults to `America/Los_Angeles` here; the timestamp-to-date cast differs from UTC; dbt-duckdb `settings: {TimeZone: UTC}` and `TZ=UTC` both fix tables; views follow the reader's zone | scratch |
| DuckDB cross-process lock (read-only open fails while another process writes); in-process dbt keeps the lock for the process lifetime; a second in-process connection with a different config fails; default-config connections coexist with dbt-duckdb | scratch |
| Per-model bucket cursor prototype: shared cursor leaves a failed downstream model stale; own cursor matches full refresh; duplicate delivery does not double count | scratch dbt project with forced `error()` fault |
| DuckDB sorts NULLs last for ASC and DESC; `DECIMAL / DECIMAL` returns DOUBLE; INT32 literal products overflow; ROUND on DECIMAL rounds half away from zero | scratch |
| dbt cross-database macros compile on DuckDB and BigQuery; result types differ; `dbt.safe_cast` is a plain cast on dbt-duckdb | scratch compile and run |
| dbt-bigquery profile fields `maximum_bytes_billed`, `impersonate_service_account` | dbt-bigquery credentials class |
| BigQuery: `FOR SYSTEM_TIME AS OF` reads the previous version after `CREATE OR REPLACE TABLE`; restore by copy does not copy partitioning information or tags | docs.cloud.google.com access-historical-data |
| GitHub Additional Product Terms on Actions (serverless application; GitHub-hosted runners for unrelated activity) | docs.github.com site-policy |
| Cloud Run roles (`run.jobsExecutor` = `run.jobs.run` + `run.executions.cancel`); `POST .../jobs/{job}:run`, overrides fields; jobs billed instance-based with a 1-minute minimum; `gcloud run jobs deploy` flags | Cloud Run IAM roles reference, execute-jobs page, pricing search results, gcloud reference |
| Secure-by-default `iam.managed.disableServiceAccountKeyCreation` for organizations created on or after 2024-05-03; WIF `--jwk-json-path` | Google Cloud docs (baseline constraints, WIF with other providers, gcloud reference) |
| Cloud Build default service account change; 2,500 free build-minutes per month; Secret Manager free tier | Cloud Build docs and pricing; Secret Manager pricing |
| ADC `set-quota-project`; missing quota project errors; `gcloud billing projects link --billing-account` | gcloud reference; quotas troubleshooting page |
| Access API: create app endpoint and `Access: Apps and Policies Write`; service tokens endpoint, `Access: Service Tokens Write`, `client_id`/`client_secret` in the response; `non_identity` with `service_token.token_id`; worker destinations cover workers.dev, routes and previews; strict service token authentication default for organizations created on or after 2026-10-05 | Cloudflare API reference, common-policies docs, Workers Access docs, Access changelog |
| AI Gateway create requires `AI Gateway Write`; runtime types expose `GatewayOptions.id` and `aiGatewayLogId` | Cloudflare API reference; generated runtime types |
| setup-uv `version` input (defaults to pyproject or latest) | `action.yml` at v10.3.0 via `gh api` |
| `wrangler dev --var`, `wrangler deploy --secrets-file`, `preview_urls` in the config schema | wrangler 4.149.0 `--help` and `config-schema.json` |

Not verified (also marked inline): Catalog URI and Warehouse output format and the REST prefix value; whether R2 notifications fire for Basin-written objects; sink-created column types; Zero Trust signup card requirement; BigQuery partition limits; GitHub Actions free minutes wording; the `worker_id` lookup for Access worker destinations and whether `aud` is in the create response; the service token rotate endpoint; Cloud Run free-tier figures for jobs and execution start time; whether `run.jobs.run` alone suffices without `actAs`; the minimal Cloud Build role set; the Basin pipeline dropped-record metrics dataset; dropping a sink-created table; Artifact Registry storage cost; `SELECT *` in pipeline SQL (avoided by listing columns). Resolved since revision 1: `gcloud billing projects link` flags (verified); the `ALTER SCHEMA` time travel DDL (no longer used); the Access UI location of the AUD tag (setup reads it from the API).

## 26. Domain glossary (seed for CONTEXT.md)
- **Source**: one of `hris`, `ats`, `talent`; each has its own envelope shape.
- **Event**: a source fact with a stable `event_id`. **Delivery**: one accepted copy of an event with its own `delivery_id`.
- **Raw record**: the normalized delivery row in the stream, lake and raw table.
- **Sink file** (local only): an NDJSON roll file written by `SinkRoller`.
- **Snapshot**: an Iceberg snapshot of `peoplelake.raw_events`. **Watermark**: the last snapshot whose data a committed run published.
- **Run**: one Workflow instance (`r-000042`). **Job**: a unit of runner work (`load` or `transform`). **Attempt**: a retry of a job with its own event type.
- **Spell**: one continuous employment period; a rehire starts spell 2.
- **Correction**: an HRIS event that replaces fields of a prior event. **Rescind**: an HRIS event that cancels a prior event.
- **Effective-dated history**: SCD2 rows valid from a business date, independent of when data arrived.
- **Published model**: one of the 10 models covered by digests. **Output digest**: SHA-256 over canonical rows of a published model.
- **Scenario**: a perturbed delivery plan (S1..S5) compared with the baseline. **Freshness**: commit time of the publishing run minus the Worker receive time of an event.
- **Quiescence**: all deliveries done, no active or pending run.
- **Load sequence** (`_pl_load_seq`): the Coordinator's monotonic number for a run's load, stamped on raw rows. **Bucket cursor**: the max load sequence a bucketed model has consumed, read from the model itself.
- **Transform skip**: a run that loaded nothing new and commits without running dbt.
- **Drill dataset**: a `pl_*_drill` BigQuery dataset used for scenario drills and restores, never for production reads.
- **Generation**: the epoch second when the Coordinator's storage was initialized; prefixes run ids and load sequences.

## 27. Build rules for the builder
- Work only in `~/Developer/projects/peoplelake`. Set git identity locally (section 23). No `Co-Authored-By` trailer in any commit. Do not push.
- Use only ports 8791, 9241 and 8150. Kill every process started before finishing and confirm the ports are free.
- Run everything in UTC (section 3.5). Only the runner process opens the DuckDB file while the stack is up (ADR 0008).
- Follow the commit order in section 23: generator, direct DuckDB load, dbt and the small-profile oracle match come before the Worker.
- Time one full scenario leg on the small profile and one on the full profile in the session before writing any CI `timeout-minutes`; record the measured durations in the README.
- Run `peoplelake dev clean-clone-check` before any commit that adds a file the warehouse or runner needs.
- No em dashes or en dashes anywhere in prose (README, docs, ADRs, runbooks, CONTEXT.md, SPEC.md); `npm run check:prose` enforces it and skips fenced code and inline code spans.
- README Results: only numbers from this repo's scripts, run in the session, with command, date and engine.
- Never present a local stand-in as the production service; every stand-in is labeled in code, logs and README.

## 28. Review log (2026-10-10, revision 2)
Each finding was re-checked before it was resolved. "Reproduced" means it was run in `/private/tmp/.../scratchpad/pl-fix` with the pinned versions; scratch processes were all short-lived, and ports 8791, 9241 and 8150 were never used.

### 28.1 Blocking
| # | Finding | Verification | Resolution |
|---|---|---|---|
| B1 | `typegen:check` fails on CI because `wrangler types` reads the gitignored `.dev.vars` | Reproduced: exit 1 "out of date"; with `--env-file .dev.vars.example`, exit 0 with and without `.dev.vars` | Both scripts use `--env-file .dev.vars.example`; the example lists every secret name (sections 4, 7.1, 19) |
| B2 | TS 6.0.3 defaults break the node tsconfig and `node scripts/*.ts` | Reproduced TS2591, TS5097, TS1294 and the Node strip-only enum failure; the fixed config passes | Section 3.1 configs; no enums in `src/shared` |
| B3 | Unit tests on incremental models fail on an empty warehouse | Reproduced on dbt-core 1.12.5 + dbt-duckdb 1.11.0; both fixes pass | Runner uses `--exclude-resource-type unit_test`; CI runs `dbt run --empty` first (sections 10.2, 11.5, 15.4, 17) |
| B4 | Oracle seeds gitignored, so prod and fresh clones fail; both profiles wrote the same seed names | Confirmed from the old file tree and runner steps | Committed `warehouse/seeds/oracle/*` with a `profile` column, `var('pl_profile')`, regenerate-and-diff test, clean-clone CI job (sections 4, 5.5, 17) |
| B5 | DuckDB uses the machine time zone | Reproduced (2025-12-31 vs 2026-01-01); profile setting and `TZ=UTC` both fix tables | Section 3.5, profile `settings`, `open_duckdb`, test |
| B6 | Shared affected-bucket watermark leaves a failed model stale in S4 | Reproduced stale output with a shared cursor; per-model cursor matched full refresh | Per-model cursors on `_pl_load_seq`, generation-prefixed sequence, dbt-level parity test (ADR 0004, sections 6.1, 11.2, 11.5) |
| B7 | DuckDB single writer across processes | Reproduced, plus two new facts: in-process dbt holds the lock for the process lifetime, and a second in-process connection with a different config fails | ADR 0008: the runner owns the file, uses default-config connections, returns digests and freshness histograms; evals open the file only after `stack down` |
| B8 | Prod freshness would time a second delivery of the same 100,000 ids | Confirmed from the old 20.5 sequence | `prod:e2e`'s single live delivery is the measurement; `--from-delivery`; refusal without `prod reset` (sections 16.2, 19, 20.5) |

### 28.2 Important
| # | Finding | Verification | Resolution |
|---|---|---|---|
| I1 | GitHub Actions as production compute: ToS risk and cold start | Read the Additional Product Terms wording; Cloud Run roles, run API and billing model checked | Decided option B: Cloud Run Job runner behind the same claim/JobSpec contract, dispatch-only key with `roles/run.jobsExecutor`, no overrides; GitHub runs CI only; WIF for GitHub, the PAT and `prod-runner.yml` removed (ADR 0002, sections 8.3, 21.2) |
| I2 | Hourly heartbeat makes "idle cost ~ $5" false | Confirmed from the old 7.6 and 10.2 | Heartbeat every 6 h is load-only; transform skip rule with the `transformed_through_seq` guard (a plain `rows_inserted == 0` rule would leave a failed transform unpublished); no unit tests in prod; `maximum_bytes_billed`; doctor prints billed bytes (sections 7.6, 8.2, 11.1, 20.1) |
| I3 | New-data trigger depended on unverified R2 notifications and a timing rule | Confirmed; Iceberg REST loadTable is the endpoint pyiceberg already uses | Per-minute catalog poll for new append snapshots; notifications kept as an optimization; doctor reports both (sections 7.6, 21.3) |
| I4 | Top-level and production Worker shared the name `peoplelake` | Reproduced the warning-only dry run | Top level `peoplelake-local` with `workers_dev: false`; local config refuses non-local hosts; name test; deploy only via `npm run deploy` (sections 7.1, 7.2, 15.2) |
| I5 | Workers AI and AI Gateway sat below the cut | Confirmed | AiProvider (stub, openai-compatible, workers-ai), minimal `/api/ask`, mocked-binding test, gateway creation and doctor check moved above the cut; README states there is no front end until the dashboard lands (sections 1, 13, 14, 23) |
| I6 | Setup steps wrong or missing | (a) quota project: verified command and error class; (b) subdomain: verified wrangler requires one for Workflows and registers it with the OAuth token; (c) drill datasets: confirmed; (d) the claim that wrangler's OAuth covers Access and AI Gateway is **not correct**: wrangler 4.149's login requests no `access:*` or `aig:*` scopes and rejects them in `--scopes` (those strings appear only in another CLI's registered-scope list in the bundle); (e) confirmed | (a) order and `set-quota-project` in 20.2; (b) setup registers the subdomain; (c) bootstrap pre-creates six `_drill` datasets with the same settings; (d) one Cloudflare custom token (`PL_CF_SETUP_TOKEN`, three verified permissions) lets setup create service tokens, the Access app and the gateway, so no manual copying remains; (e) `RUNS_ENABLED=false` until GCP passes |
| I7 | `bq cp` restore loses partitioning and tags; SQL template was wrong | Docs: partitioning information and tags are not copied; time travel works after `CREATE OR REPLACE` | SQL restore into `_drill` with explicit range partition and clustering, policy tags copied before reads, digest check; templates removed (section 11.7) |
| I8 | Cross-engine digest parity hazards | Reproduced DuckDB NULLS LAST default, decimal division to DOUBLE, INT32 overflow; dbt cross-db macros compile on both engines but return different types; found that `dbt.safe_cast` is a plain cast on DuckDB | Wrapped dbt macros with DATE casts, `pl_try_cast`, `pl_int_div`, integer basis points and parts per million, explicit NULLS LAST with total orders, sqlglot lint in CI (sections 5.4, 11.4, 11.8) |
| I9 | Resume bullets read as BigQuery facts but evidence was DuckDB-only | Confirmed | BigQuery drill scenarios are a required go-live step and a doctor check; results carry engine labels; README Status wording (sections 16.5, 20.5, 22) |
| I10 | CI e2e too slow; eval-full on every push would time out | Estimate accepted; not timed yet (no code exists) | Scenario matrix, reference digests from the dbt job, in-process dbt with no per-run vars, eval-full on dispatch or weekly, timeouts set from measured runs, data-core-first build order (sections 10.2, 17, 23, 27) |
| I11 | Generator rules conflicted with R6 and R11 | Confirmed by reading 5.2 and 5.3 | 1..20 day hire-date shifts never across the decision date; talent events on true dates; termination corrections bounded; oracle-side R6/R11 tests before any dbt (section 5.3) |
| I12 | S2 could not be produced by the fault mechanism | Confirmed | `rewind_watermark{snapshots}` and `recommit_sink_files{count}` fault kinds with unit tests (sections 8.4, 9.3, 16.1) |
| I13 | Setup checklist for Nitish | Rebuilt from verified facts; corrected where the reviewer's version relied on wrangler OAuth scopes and on GitHub | Sections 20.2 to 20.5 and the returned summary |

### 28.3 Minor
| Finding | Resolution |
|---|---|
| WIF hardening for the GitHub runner | Moot: GitHub has no production role or cloud credentials. CI keeps `permissions: contents: read`; SHA pinning noted as optional hardening |
| `stg_events` merge let a later duplicate overwrite the first delivery | Insert-only behavior via anti-join, earliest `received_at` within a batch (section 11.2; prototype verified) |
| Workflow instance id reuse after a Coordinator reset; `create` not idempotent; `sendEvent` to finished instances | Generation-prefixed ids, `get` before `create`, caught `sendEvent` errors (section 8.1) |
| Offline BigQuery compile covered only the full-build branch | Second compile forcing the incremental branch, sqlglot parse of both, manifest assertions (section 11.9) |
| Canonical JSON differs between TS and Python for non-integral numbers | Integer-only payloads (basis points) and a shared golden (section 5.4) |
| uv version drift in CI | `version: "0.12.17"` in setup-uv and `required-version` in pyproject (sections 3.2, 3.3, 17) |
| doctor plan probe | Workers Paid is PASS only when a paid-only resource exists, otherwise UNKNOWN (section 21.3) |
| Basin silently drops invalid records after a 202 | R7 is error-level in `prod verify`; dropped-record metrics checked, dataset unverified (sections 11.6, 20.5) |
| Local cron path | Ticker uses the printed `/cdn-cgi/local/scheduled` and falls back to `/cdn-cgi/handler/scheduled` (section 7.1) |
| Plaintext secrets on disk | Mode 600 enforced, doctor warns, names only (sections 20.4, 21.3) |
| Unverified `ALTER SCHEMA` time travel DDL | Removed; the pinned client sets `max_time_travel_hours` (section 11.7) |
| Python and Node pins, vitest plugin exports, wrangler commands, action tags | Re-confirmed where touched; no change needed |
