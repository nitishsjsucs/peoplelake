# Runbook: rotate credentials

All secrets live in `.prod/*` (mode 600, gitignored), in the Worker secret `GCP_DISPATCHER_KEY` and in Secret Manager. `npm run doctor` warns on file modes and prints names only.

| Credential | Where it is used | Rotate |
|---|---|---|
| Access service tokens `peoplelake-source-hris`, `peoplelake-source-ats`, `peoplelake-source-talent`, `peoplelake-runner`, `peoplelake-doctor` (1 year) | sources, the runner (via Secret Manager), doctor | delete the token's `PL_CF_*_CLIENT_SECRET` line from `.prod/secrets.env` and run `npm run setup:prod -- --only cloudflare`; it rotates the token, saves the new secret, then run `npm run setup:prod -- --only gcp` (Secret Manager) and `--only worker` (role map) |
| `PL_R2_CATALOG_TOKEN` (R2 Admin Read & Write; the only R2 token) | the runner's Basin Catalog commits (Secret Manager `peoplelake-r2-catalog-token`), `peoplelake lake init` and snapshot expiration during setup | create a new R2 API token with Admin Read & Write in the dashboard (R2, Manage API tokens), replace it in `.prod/secrets.env`, run `npm run setup:prod -- --only gcp` (adds a new secret version that the next runner execution reads), then revoke the old token. The token reaches every bucket on the account, including other repos' buckets, so rotate it if `.prod/secrets.env` may have leaked. The Worker never holds it. |
| `PL_CF_SETUP_TOKEN` | setup only | create a new custom token with the same three permissions (Access: Apps and Policies, Access: Service Tokens, AI Gateway, all edit) and replace it in `.prod/secrets.env` |
| `.prod/gcp-dispatcher-key.json` | Worker secret `GCP_DISPATCHER_KEY` | `gcloud iam service-accounts keys list --iam-account peoplelake-dispatcher@<project>.iam.gserviceaccount.com`, delete the old key after moving the file aside, run `npm run setup:prod -- --only gcp` (creates a new key because the file is absent) and `--only worker` |

Access signing keys rotate on Cloudflare's side every 6 weeks; the Worker fetches the team JWKS, so nothing changes here.
