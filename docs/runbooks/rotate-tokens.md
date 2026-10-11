# Runbook: rotate credentials

All secrets live in `.prod/*` (mode 600, gitignored), in Worker secrets and in Secret Manager. `npm run doctor` warns on file modes and prints names only.

| Credential | Where it is used | Rotate |
|---|---|---|
| Access service tokens `pl-source-hris`, `pl-source-ats`, `pl-source-talent`, `pl-runner`, `pl-doctor` (1 year) | sources, the runner (via Secret Manager), doctor | delete the token's `PL_CF_*_CLIENT_SECRET` line from `.prod/secrets.env` and run `npm run setup:prod -- --only cloudflare`; it rotates the token, saves the new secret, then run `npm run setup:prod -- --only gcp` (Secret Manager) and `--only worker` (role map) |
| `PL_R2_SINK_TOKEN` (R2 Admin Read and Write) | Basin sink, catalog maintenance | create a new R2 API token in the dashboard, update `.prod/secrets.env`, delete the pipeline `peoplelake_raw_pipeline` and the sink `peoplelake_raw_sink` with `wrangler pipelines delete` and `wrangler pipelines sinks delete`, then `npm run setup:prod -- --only cloudflare` recreates both with the new token (this repository has not tested editing a sink's token in place) |
| `PL_R2_CATALOG_TOKEN` (R2 Admin Read) | Worker catalog poll, runner | new token in the dashboard, update `.prod/secrets.env`, `npm run setup:prod -- --only gcp` then `--only worker` |
| `PL_CF_SETUP_TOKEN` | setup only | create a new custom token with the same three permissions and replace it in `.prod/secrets.env` |
| `.prod/gcp-dispatcher-key.json` | Worker secret `GCP_DISPATCHER_KEY` | `gcloud iam service-accounts keys list --iam-account peoplelake-dispatcher@<project>.iam.gserviceaccount.com`, delete the old key after moving the file aside, run `npm run setup:prod -- --only gcp` (creates a new key because the file is absent) and `--only worker` |

Access signing keys rotate on Cloudflare's side every 6 weeks; the Worker fetches the team JWKS, so nothing changes here.
