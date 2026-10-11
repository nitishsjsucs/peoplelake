# Google Cloud resources

The Google Cloud project is shared by four repos, so every name below starts with `peoplelake`, every grant is scoped to a dataset or a resource, and the only project-level roles are `roles/bigquery.jobUser` (runner and analyst) and `roles/logging.logWriter` (the build identity), neither of which reads data (SPEC 29.4.6).

`uv run --project pipeline peoplelake prod bootstrap-gcp` (also a step of `npm run setup:prod`) refuses to run while billing is disabled on the project (the BigQuery sandbox rejects DML and gives new tables a 60-day expiration), then creates, each only if absent:

| Resource | Details |
|---|---|
| APIs | BigQuery, BigQuery Storage, Data Catalog, BigQuery Data Policy, IAM, IAM Credentials, Resource Manager, Cloud Run, Artifact Registry, Cloud Build, Secret Manager |
| Datasets (location US, label `app=peoplelake`, no default table or partition expiration) | `peoplelake_raw`, `peoplelake_staging`, `peoplelake_ops` (time travel 48 h); `peoplelake_core`, `peoplelake_restricted`, `peoplelake_restricted_access` (views only), `peoplelake_reporting` (168 h); the same seven with suffix `_drill`. An existing dataset with a default expiration (made in the sandbox) has it cleared. |
| Policy tags | taxonomy `peoplelake-sensitivity` (fine-grained access control) with tags `compensation` and `performance` |
| Data masking | `peoplelake_mask_compensation` (default masking value) and `peoplelake_mask_performance` (always null) |
| Service accounts | `peoplelake-runner` (project: BigQuery job user; owner of the fourteen datasets, fine-grained reader on both tags, viewer of the taxonomy, accessor of its three secrets), `peoplelake-analyst` (project: job user; viewer of `peoplelake_reporting` and `peoplelake_restricted_access` only, both views, never of `peoplelake_restricted`, where dbt leaves untagged `__dbt_tmp` copies; masked reader on both data policies), `peoplelake-dispatcher` (`roles/run.jobsExecutor` on the job only; one JSON key in `.prod/gcp-dispatcher-key.json`), `peoplelake-build` (project: log writer; object admin on the build bucket, writer on the Artifact Registry repository) |
| Secrets | `peoplelake-r2-catalog-token` (the R2 Admin Read & Write token the runner commits to Basin Catalog with), `peoplelake-runner-client-id`, `peoplelake-runner-client-secret` (new version only when the value changed) |
| Build bucket | `gs://peoplelake-build-<project>` (uniform access, public access prevented): Cloud Build's source staging for `peoplelake-build` |
| Artifact Registry | Docker repository `peoplelake` in `us-central1`, cleanup keeps 2 images (`cleanup-policy.json`) |
| Runner image | built by Cloud Build from the repo root with `cloudbuild.yaml`, as `peoplelake-build` (`--service-account`, `--gcs-source-staging-dir`, logs to Cloud Logging only); refuses a dirty working tree. The Cloud Build default service account gets nothing. |
| Cloud Run Job | `peoplelake-runner`: 1 task, no retries, 45 minute timeout, 1 vCPU, 2 GiB, label `app=peoplelake`, runs `peoplelake runner run --until-idle 15 --target prod` as `peoplelake-runner` |

Every BigQuery query this repo issues is capped at 1 GB billed and labeled `app=peoplelake` (`bigquery_client()` in `pipeline/src/peoplelake/warehouse/bigquery_wh.py`, and `maximum_bytes_billed` in the dbt profiles).

`--plan` prints every mutation without making it, and no gcloud call ever prompts (prompts and gcloud's offer to enable a disabled API are both off), so a plan cannot change the project. Bootstrap also stops before creating anything when `.prod/state.json` lacks the workers.dev subdomain or the Basin Catalog URI and warehouse that the Cloud Run job needs: the Cloudflare part of `npm run setup:prod` records them first. The caller also gets `roles/iam.serviceAccountTokenCreator` on `peoplelake-runner` and `peoplelake-analyst` so the BigQuery drills and the masking demo can impersonate them. The minimal role set for `peoplelake-build` is not verified; `npm run doctor` checks the build identity and the project-level roles of every `peoplelake-*` service account.
