# Google Cloud resources

`uv run --project pipeline peoplelake prod bootstrap-gcp` (also step 15 of `npm run setup:prod`) creates, each only if absent:

| Resource | Details |
|---|---|
| APIs | BigQuery, BigQuery Storage, Data Catalog, BigQuery Data Policy, IAM, IAM Credentials, Resource Manager, Cloud Run, Artifact Registry, Cloud Build, Secret Manager |
| Datasets (location US) | `pl_raw`, `pl_staging`, `pl_ops` (time travel 48 h); `pl_core`, `pl_restricted`, `pl_reporting` (168 h); the same six with suffix `_drill` |
| Policy tags | taxonomy `peoplelake-sensitivity` (fine-grained access control) with tags `compensation` and `performance` |
| Data masking | `pl_mask_compensation` (default masking value) and `pl_mask_performance` (always null) |
| Service accounts | `pl-runner` (BigQuery job user, owner of the twelve datasets, fine-grained reader on both tags, accessor of three secrets), `pl-analyst` (job user, viewer of `pl_reporting` and `pl_restricted`, masked reader), `pl-dispatcher` (`roles/run.jobsExecutor` on the job only; one JSON key in `.prod/gcp-dispatcher-key.json`) |
| Secrets | `pl-r2-catalog-token`, `pl-runner-client-id`, `pl-runner-client-secret` (new version only when the value changed) |
| Artifact Registry | Docker repository `peoplelake` in `us-central1`, cleanup keeps 3 images (`cleanup-policy.json`) |
| Runner image | built by Cloud Build from the repo root with `cloudbuild.yaml` (refuses a dirty working tree) |
| Cloud Run Job | `peoplelake-runner`: 1 task, no retries, 45 minute timeout, 1 vCPU, 2 GiB, runs `peoplelake runner run --until-idle 15 --target prod` as `pl-runner` |

`--plan` prints every mutation without making it. The caller also gets `roles/iam.serviceAccountTokenCreator` on `pl-runner` and `pl-analyst` so the BigQuery drills and the masking demo can impersonate them.
