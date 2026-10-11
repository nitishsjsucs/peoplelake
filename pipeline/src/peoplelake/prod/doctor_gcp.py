"""`peoplelake prod doctor-gcp` (SPEC 21.3, Google Cloud part). Never prints secret values."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from ..paths import repo_root
from .bootstrap_gcp import (
    DATA_POLICIES,
    JOB,
    SECRETS,
    SERVICES,
    TAXONOMY,
    GcpConfig,
    all_datasets,
    key_creation_blocked,
)
from .checks import Check, run_check


def _gcloud(args: list[str], project: str | None = None) -> subprocess.CompletedProcess:
    argv = ["gcloud", *args] + (["--project", project] if project else [])
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def doctor(prod_dir: Path | None = None) -> list[Check]:
    prod_dir = prod_dir or repo_root() / ".prod"
    out: list[Check] = []
    if shutil.which("gcloud") is None:
        return [
            Check(
                "gcloud installed",
                "MISSING",
                "gcloud is not on PATH",
                "brew install --cask gcloud-cli, then gcloud auth login",
            )
        ]
    out.append(Check("gcloud installed", "PASS"))
    try:
        config = GcpConfig.load(prod_dir)
    except SystemExit as exc:
        return [
            *out,
            Check(
                ".prod/config.env",
                "MISSING",
                str(exc),
                "fill PL_GCP_PROJECT and the other keys (README production setup, step 12)",
            ),
        ]
    p = config.project

    def login() -> Check:
        account = _gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).stdout.strip()
        return Check("gcloud login", "PASS" if account else "MISSING", account, "gcloud auth login")

    def adc() -> Check:
        path = (
            Path(os.environ.get("CLOUDSDK_CONFIG", Path.home() / ".config" / "gcloud"))
            / "application_default_credentials.json"
        )
        if not path.exists():
            return Check("application default credentials", "MISSING", "", "gcloud auth application-default login")
        quota = json.loads(path.read_text()).get("quota_project_id")
        ok = quota == p
        return Check(
            "ADC quota project",
            "PASS" if ok else "FAIL",
            f"quota_project_id={quota}",
            f"gcloud auth application-default set-quota-project {p}",
        )

    def project() -> Check:
        res = _gcloud(["projects", "describe", p, "--format=value(projectId)"])
        return Check(f"project {p}", "PASS" if res.returncode == 0 else "MISSING", "", f"gcloud projects create {p}")

    def billing() -> Check:
        enabled = _gcloud(["billing", "projects", "describe", p, "--format=value(billingEnabled)"]).stdout.strip()
        return Check(
            "billing enabled",
            "PASS" if enabled.lower() == "true" else "FAIL",
            enabled,
            f"gcloud billing projects link {p} --billing-account=<BILLING_ACCOUNT_ID>",
        )

    def apis() -> Check:
        enabled = set(_gcloud(["services", "list", "--enabled", "--format=value(config.name)"], p).stdout.split())
        missing = [s for s in SERVICES if s not in enabled]
        return Check(
            "APIs enabled", "PASS" if not missing else "MISSING", ", ".join(missing), "npm run setup:prod -- --only gcp"
        )

    def key_policy() -> Check:
        parent = _gcloud(["projects", "describe", p, "--format=value(parent.type)"]).stdout.strip()
        if parent != "organization":
            return Check("service account key creation", "PASS", "no organization policy applies")
        policy = _gcloud(
            [
                "resource-manager",
                "org-policies",
                "describe",
                "iam.managed.disableServiceAccountKeyCreation",
                "--effective",
                "--format=json",
            ],
            p,
        ).stdout
        blocked = key_creation_blocked(policy)
        return Check(
            "service account key creation",
            "FAIL" if blocked else "PASS",
            "blocked by organization policy" if blocked else "allowed",
            "use a project without an organization (SPEC risk 14) or ask an org admin for an exception",
        )

    def service_accounts() -> Check:
        missing = [
            sa
            for sa in (config.runner_sa, config.analyst_sa, config.dispatcher_sa)
            if _gcloud(["iam", "service-accounts", "describe", sa], p).returncode != 0
        ]
        return Check(
            "service accounts",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            "npm run setup:prod -- --only gcp",
        )

    def datasets() -> Check:
        from google.api_core.exceptions import NotFound
        from google.cloud import bigquery

        bq = bigquery.Client(project=p, location=config.bq_location)
        problems = []
        for name, hours in all_datasets():
            try:
                ds = bq.get_dataset(f"{p}.{name}")
            except NotFound:
                problems.append(f"{name} missing")
                continue
            if ds.max_time_travel_hours != hours:
                problems.append(f"{name} time travel {ds.max_time_travel_hours} h (want {hours})")
        return Check(
            "datasets and time travel",
            "PASS" if not problems else "FAIL",
            "; ".join(problems) or "12 datasets",
            "npm run setup:prod -- --only gcp",
        )

    def taxonomy() -> Check:
        from google.cloud import bigquery_datapolicies_v1, datacatalog_v1

        parent = f"projects/{p}/locations/us"
        found = [
            t
            for t in datacatalog_v1.PolicyTagManagerClient().list_taxonomies(parent=parent)
            if t.display_name == TAXONOMY
        ]
        policies = {
            d.data_policy_id
            for d in bigquery_datapolicies_v1.DataPolicyServiceClient().list_data_policies(parent=parent)
        }
        missing = [x for x in DATA_POLICIES if x not in policies] + ([] if found else [TAXONOMY])
        return Check(
            "policy tags and data masking",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            "npm run setup:prod -- --only gcp",
        )

    def secrets() -> Check:
        missing = [s for s in SECRETS if _gcloud(["secrets", "describe", s], p).returncode != 0]
        return Check(
            "Secret Manager secrets (names only)",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            "npm run setup:prod -- --only gcp",
        )

    def job() -> Check:
        res = _gcloud(["run", "jobs", "describe", JOB, f"--region={config.region}", "--format=json"], p)
        if res.returncode != 0:
            return Check("Cloud Run Job", "MISSING", JOB, "npm run setup:prod -- --only gcp")
        labels = json.loads(res.stdout).get("metadata", {}).get("labels", {})
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_root(), capture_output=True, text=True
        ).stdout.strip()
        stale = labels.get("git-sha") != head[:40]
        return Check(
            "Cloud Run Job image",
            "WARN" if stale else "PASS",
            f"image git-sha {labels.get('git-sha')} vs HEAD {head[:12]}",
            "npm run deploy:runner",
        )

    def last_execution() -> Check:
        res = _gcloud(
            [
                "run",
                "jobs",
                "executions",
                "list",
                f"--job={JOB}",
                f"--region={config.region}",
                "--limit=1",
                "--format=json",
            ],
            p,
        )
        rows = json.loads(res.stdout or "[]")
        if not rows:
            return Check("last runner execution", "UNKNOWN", "no executions yet", "npm run prod:e2e")
        conditions = {c.get("type"): c.get("status") for c in rows[0].get("status", {}).get("conditions", [])}
        return Check(
            "last runner execution",
            "PASS" if conditions.get("Completed") == "True" else "FAIL",
            json.dumps(conditions),
            "gcloud run jobs executions describe (see logs)",
        )

    def billed() -> Check:
        from google.cloud import bigquery

        bq = bigquery.Client(project=p, location=config.bq_location)
        sql = (
            "SELECT IFNULL(SUM(total_bytes_billed), 0) AS b FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT "
            "WHERE user_email = @sa AND creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)"
        )
        cfg = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("sa", "STRING", config.runner_sa)]
        )
        b = list(bq.query(sql, job_config=cfg).result())[0]["b"]
        return Check("BigQuery bytes billed by pl-runner (24 h)", "PASS", f"{int(b):,} bytes")

    def files() -> Check:
        bad = []
        for f in ("config.env", "secrets.env", "state.json", "gcp.json", "gcp-dispatcher-key.json"):
            path = prod_dir / f
            if path.exists() and path.stat().st_mode & 0o077:
                bad.append(f)
        return Check(".prod files mode 600", "PASS" if not bad else "WARN", ", ".join(bad), "chmod 600 .prod/*")

    def evidence() -> Check:
        results = repo_root() / "evals" / "results"
        prod_fresh = list(results.glob("freshness-prod-*.json"))
        drill = list(results.glob("scenarios-*-bigquery-*.json"))
        missing = ([] if prod_fresh else ["prod:e2e freshness"]) + ([] if drill else ["BigQuery drill"])
        return Check(
            "go-live evidence",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            "npm run prod:e2e; uv run --project pipeline peoplelake eval scenarios --profile small --chunks 10 --target prod-drill",
        )

    for name, fn in (
        ("gcloud login", login),
        ("ADC", adc),
        ("project", project),
        ("billing", billing),
        ("APIs", apis),
        ("key policy", key_policy),
        ("service accounts", service_accounts),
        ("datasets", datasets),
        ("taxonomy", taxonomy),
        ("secrets", secrets),
        ("job", job),
        ("execution", last_execution),
        ("billed bytes", billed),
        ("files", files),
        ("evidence", evidence),
    ):
        out.append(run_check(name, fn, "see README production setup"))
    return out
