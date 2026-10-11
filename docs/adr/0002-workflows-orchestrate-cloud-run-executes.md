# ADR 0002: Workflows orchestrate, a Cloud Run Job executes

Status: accepted (2026-10-10)

## Context
Workers cannot run dbt or pyiceberg. The orchestration must survive retries and lost results, and the compute must run next to BigQuery without long-lived keys for data access.

## Decision
`WarehouseRunWorkflow` owns sequencing, retries and the commit. Work is handed to a runner through attempt-scoped jobs in the Coordinator Durable Object and `step.waitForEvent` on `<kind>-result-a<n>`, so a stale result from attempt 1 can never satisfy the wait for attempt 2. In production the runner is the Cloud Run Job `peoplelake-runner` in `us-central1`, running as the service account `peoplelake-runner` (BigQuery access through the metadata server, no key). The Worker starts an execution with `jobs.run` and an empty body (no overrides) using a dispatch-only identity (`roles/run.jobsExecutor` on that job); the execution claims whatever job is queued. Locally the same runner CLI polls `/internal/jobs/claim`.

GitHub-hosted Actions were rejected as production compute: GitHub's Additional Product Terms say Actions should not be used as part of a serverless application, and hosted runners add queueing. Actions run CI only and hold no cloud credentials.

## Consequences
A leaked dispatcher key can only start the job as configured. Duplicate dispatches are harmless (one lease holder per job; an idle execution exits after 15 s). Production Workflows timing is exercised only after deploy; CI exercises Miniflare's implementation.
