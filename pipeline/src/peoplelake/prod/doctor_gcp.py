"""`peoplelake prod doctor-gcp` (SPEC 21.3 and 21.0, Google Cloud part). Read only; never prints secret values.

It runs before anything is provisioned as well as after: the project comes from `.prod/config.env`
(`PL_GCP_PROJECT`, which the environment may override) or else from `gcloud config`, and every check that
finds nothing says exactly what is missing and which README production setup step or command fixes it.

Read only by construction: every gcloud command goes through `ReadOnlyGcloud`, which refuses anything
outside a list of describe, list and get commands and runs gcloud with prompts off and API enablement
prompts off (gcloud otherwise offers to enable a disabled API, which would change the project). The
Google client calls are gets and lists; the one query (bytes billed this month, capped at 1 GB) runs only
once a `peoplelake-*` service account exists, since nothing can be billed to accounts that do not exist.

The project is shared by four repos: besides the resources, it checks that this repo's service accounts
hold no project-level role other than `roles/bigquery.jobUser` and `roles/logging.logWriter`, that no
`peoplelake_*` dataset has a default expiration, and the bytes billed this month by the `peoplelake-*`
service accounts against the 275 GB monthly guard."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..budget import BQ_MONTHLY_BYTES_CAP
from ..envfile import read_env_file
from ..paths import repo_root
from .bootstrap_gcp import (
    DATA_POLICIES,
    JOB,
    REPO,
    SECRETS,
    SERVICE_ACCOUNTS,
    SERVICES,
    TAXONOMY,
    GcpConfig,
    all_datasets,
    build_bucket,
    extra_project_roles,
    key_creation_blocked,
)
from .checks import Check, run_check

MONTH_BILLED_SQL = (
    "SELECT IFNULL(SUM(total_bytes_billed), 0) AS b FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT "
    "WHERE STARTS_WITH(user_email, 'peoplelake-') AND creation_time >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)"
)

# README "Production setup", "Steps only a person can do": the numbers the fixes cite (a test reads README).
README_STEP = {"billing": 4, "quota_project": 6, "prod_files": 7, "setup": 8, "go_live": 10}
SETUP_FIX = f"npm run setup:prod (README production setup step {README_STEP['setup']})"
PROD_FILES_FIX = f"README production setup step {README_STEP['prod_files']}: .prod/config.env and .prod/secrets.env"

# The only gcloud commands the doctor may run (prefixes of the argument list).
READ_ONLY_GCLOUD: tuple[tuple[str, ...], ...] = (
    ("auth", "list"),
    ("config", "get-value"),
    ("projects", "describe"),
    ("projects", "get-iam-policy"),
    ("billing", "projects", "describe"),
    ("services", "list"),
    ("resource-manager", "org-policies", "describe"),
    ("iam", "service-accounts", "describe"),
    ("storage", "buckets", "describe"),
    ("secrets", "describe"),
    ("artifacts", "repositories", "describe"),
    ("run", "jobs", "describe"),
    ("run", "jobs", "executions", "list"),
)
# No prompts at all, and in particular no "API ... not enabled, enable and retry?" (gcloud core properties
# disable_prompts and should_prompt_to_enable_api).
GCLOUD_ENV = {"CLOUDSDK_CORE_DISABLE_PROMPTS": "1", "CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API": "false"}


def gcloud_read_only(args: list[str]) -> bool:
    return any(tuple(args[: len(prefix)]) == prefix for prefix in READ_ONLY_GCLOUD)


class ReadOnlyGcloud:
    def __init__(self, runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> None:
        self.runner = runner
        self.project: str | None = None
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], *, project: bool = True) -> subprocess.CompletedProcess:
        if not gcloud_read_only(args):
            raise PermissionError(f"the doctor runs read-only gcloud commands only, not: gcloud {' '.join(args[:4])}")
        argv = ["gcloud", *args] + (["--project", self.project] if project and self.project else [])
        self.calls.append(argv)
        return self.runner(
            argv,
            capture_output=True,
            text=True,
            check=False,
            stdin=subprocess.DEVNULL,
            env={**os.environ, **GCLOUD_ENV},
        )


def api_disabled(exc: BaseException) -> bool:
    text = str(exc)
    return "SERVICE_DISABLED" in text or "has not been used in project" in text or "it is disabled" in text


def month_bytes_billed(client) -> int:  # noqa: ANN001
    """Bytes billed this UTC month by this repo's service accounts (the caller needs project-wide job
    visibility: the owner's ADC)."""
    return int(list(client.query(MONTH_BILLED_SQL).result())[0]["b"])


@dataclass
class Readers:
    """Google client reads, injectable for tests. Each raises the client's own exceptions."""

    adc: Callable[[], tuple[bool, str | None]]
    get_dataset: Callable[[str], Any]  # dataset id -> dataset, or None when it does not exist
    taxonomies: Callable[[str], list[str]]  # location parent -> display names
    data_policies: Callable[[str], list[str]]  # location parent -> data policy ids
    month_billed: Callable[[], int]


def real_readers(project: str, location: str) -> Readers:
    from .adc import adc_quota_project

    def bq():
        from ..warehouse.bigquery_wh import bigquery_client

        return bigquery_client(project, location)

    def get_dataset(name: str):
        from google.api_core.exceptions import NotFound

        try:
            return bq().get_dataset(f"{project}.{name}")
        except NotFound:
            return None

    def taxonomies(parent: str) -> list[str]:
        from google.cloud import datacatalog_v1

        return [t.display_name for t in datacatalog_v1.PolicyTagManagerClient().list_taxonomies(parent=parent)]

    def data_policies(parent: str) -> list[str]:
        from google.cloud import bigquery_datapolicies_v1

        client = bigquery_datapolicies_v1.DataPolicyServiceClient()
        return [d.data_policy_id for d in client.list_data_policies(parent=parent)]

    return Readers(
        adc=adc_quota_project,
        get_dataset=get_dataset,
        taxonomies=taxonomies,
        data_policies=data_policies,
        month_billed=lambda: month_bytes_billed(bq()),
    )


def resolve_config(prod_dir: Path, env: Mapping[str, str], gcloud: ReadOnlyGcloud) -> tuple[GcpConfig | None, Check]:
    """`.prod/config.env` (PL_* environment variables override it), else the project gcloud is configured for."""
    in_file = read_env_file(prod_dir / "config.env")
    merged = {**in_file, **{k: v for k, v in env.items() if k.startswith("PL_") and v}}
    project = merged.get("PL_GCP_PROJECT", "")
    if project:
        config = GcpConfig.load(prod_dir) if in_file.get("PL_GCP_PROJECT") else GcpConfig(project=project)
        config.project = project
        config.region = merged.get("PL_GCP_REGION", config.region)
        config.bq_location = merged.get("PL_BQ_LOCATION", config.bq_location)
        return config, Check("Google Cloud project", "PASS", f"{project} (PL_GCP_PROJECT)")
    configured = gcloud(["config", "get-value", "project"], project=False).stdout.strip()
    fix = PROD_FILES_FIX
    if configured and configured != "(unset)":
        detail = f"PL_GCP_PROJECT is not set; checking {configured} from gcloud config"
        return GcpConfig(project=configured), Check("Google Cloud project", "MISSING", detail, fix)
    return None, Check("Google Cloud project", "MISSING", "PL_GCP_PROJECT is not set and gcloud has no project", fix)


def doctor(
    prod_dir: Path | None = None,
    *,
    gcloud: ReadOnlyGcloud | None = None,
    readers: Callable[[str, str], Readers] = real_readers,
    env: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> list[Check]:
    prod_dir = prod_dir or repo_root() / ".prod"
    gcloud = gcloud or ReadOnlyGcloud()
    env = os.environ if env is None else env
    out: list[Check] = []
    if which("gcloud") is None:
        return [
            Check(
                "gcloud installed",
                "MISSING",
                "gcloud is not on PATH",
                "brew install --cask gcloud-cli, then gcloud auth login",
            )
        ]
    out.append(Check("gcloud installed", "PASS"))
    account = gcloud(
        ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], project=False
    ).stdout.strip()
    out.append(Check("gcloud login", "PASS" if account else "MISSING", "", "gcloud auth login"))
    config, project_check = resolve_config(prod_dir, env, gcloud)
    out.append(project_check)
    if config is None:
        return out
    p = config.project
    gcloud.project = p
    read = readers(p, config.bq_location)
    state: dict[str, Any] = {"apis": set(), "service_accounts": set(), "job": False}

    def missing_api(api: str) -> str:
        return f"API {api} is not enabled yet (setup enables it through bootstrap-gcp)"

    def adc() -> Check:
        loaded, quota = read.adc()
        fix = (
            f"README production setup step {README_STEP['quota_project']}: "
            f"gcloud auth application-default set-quota-project {p}"
        )
        if not loaded:
            return Check("application default credentials", "MISSING", "", "gcloud auth application-default login")
        return Check("ADC quota project", "PASS" if quota == p else "FAIL", f"quota_project_id={quota}", fix)

    def project() -> Check:
        res = gcloud(["projects", "describe", p, "--format=value(projectId)"], project=False)
        return Check(
            f"project {p} exists",
            "PASS" if res.returncode == 0 else "MISSING",
            "",
            "the project is shared and must exist already; check PL_GCP_PROJECT",
        )

    def billing() -> Check:
        res = gcloud(["billing", "projects", "describe", p, "--format=value(billingEnabled)"], project=False)
        enabled = res.stdout.strip()
        return Check(
            "billing enabled",
            "PASS" if enabled.lower() == "true" else "FAIL",
            f"billingEnabled={enabled or 'unknown'}"
            + ("" if enabled.lower() == "true" else " (sandbox: no DML, 60-day table expiration)"),
            f"README production setup step {README_STEP['billing']}: "
            f"gcloud billing projects link {p} --billing-account=<OPEN_BILLING_ACCOUNT_ID>",
        )

    def apis() -> Check:
        enabled = set(gcloud(["services", "list", "--enabled", "--format=value(config.name)"]).stdout.split())
        state["apis"] = enabled
        missing = [s for s in SERVICES if s not in enabled]
        return Check(
            f"APIs enabled ({len(SERVICES) - len(missing)} of {len(SERVICES)})",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            SETUP_FIX,
        )

    def key_policy() -> Check:
        parent = gcloud(["projects", "describe", p, "--format=value(parent.type)"], project=False).stdout.strip()
        if parent != "organization":
            return Check("service account key creation", "PASS", "no organization policy applies")
        policy = gcloud(
            [
                "resource-manager",
                "org-policies",
                "describe",
                "iam.managed.disableServiceAccountKeyCreation",
                "--effective",
                "--format=json",
            ]
        ).stdout
        blocked = key_creation_blocked(policy)
        return Check(
            "service account key creation",
            "FAIL" if blocked else "PASS",
            "blocked by organization policy" if blocked else "allowed",
            "use a project without an organization (SPEC risk 14) or ask an org admin for an exception",
        )

    def service_accounts() -> Check:
        present = {
            name
            for name in SERVICE_ACCOUNTS
            if gcloud(["iam", "service-accounts", "describe", config.sa(name)]).returncode == 0
        }
        state["service_accounts"] = present
        missing = [name for name in SERVICE_ACCOUNTS if name not in present]
        return Check(
            f"service accounts ({len(present)} of {len(SERVICE_ACCOUNTS)})",
            "PASS" if not missing else "MISSING",
            ", ".join(missing),
            SETUP_FIX,
        )

    def project_roles() -> Check:
        policy = json.loads(gcloud(["projects", "get-iam-policy", p, "--format=json"], project=False).stdout or "{}")
        extra = extra_project_roles(policy, {f"serviceAccount:{config.sa(n)}" for n in SERVICE_ACCOUNTS})
        return Check(
            "project-level roles of the peoplelake service accounts",
            "PASS" if not extra else "FAIL",
            "; ".join(extra) or "only roles/bigquery.jobUser and roles/logging.logWriter",
            "gcloud projects remove-iam-policy-binding (the shared project allows only resource-scoped grants)",
        )

    def build_identity() -> Check:
        ok = gcloud(["storage", "buckets", "describe", f"gs://{build_bucket(p)}"]).returncode == 0
        return Check("build bucket for peoplelake-build", "PASS" if ok else "MISSING", build_bucket(p), SETUP_FIX)

    def datasets() -> Check:
        problems, missing = [], []
        for name, hours in all_datasets():
            ds = read.get_dataset(name)
            if ds is None:
                missing.append(name)
                continue
            if ds.max_time_travel_hours != hours:
                problems.append(f"{name} time travel {ds.max_time_travel_hours} h (want {hours})")
            if ds.default_table_expiration_ms is not None or ds.default_partition_expiration_ms is not None:
                problems.append(f"{name} has a default expiration (created in the sandbox?)")
        if missing and len(missing) == len(all_datasets()):
            return Check("BigQuery datasets", "MISSING", f"none of the {len(missing)} peoplelake_* datasets", SETUP_FIX)
        if missing:
            problems.insert(0, f"missing {', '.join(missing)}")
        return Check(
            "BigQuery datasets, time travel, no default expiration",
            "PASS" if not problems else "FAIL",
            "; ".join(problems) or f"{len(all_datasets())} datasets",
            SETUP_FIX,
        )

    def taxonomy() -> Check:
        name = "policy tags and data masking"
        if "datacatalog.googleapis.com" not in state["apis"]:
            return Check(name, "MISSING", missing_api("datacatalog.googleapis.com"), SETUP_FIX)
        parent = f"projects/{p}/locations/us"
        try:
            found = TAXONOMY in read.taxonomies(parent)
            policies = set(read.data_policies(parent))
        except Exception as exc:  # noqa: BLE001
            if api_disabled(exc):
                return Check(name, "MISSING", f"an API is not enabled yet: {str(exc)[:120]}", SETUP_FIX)
            raise
        missing = ([] if found else [TAXONOMY]) + [x for x in DATA_POLICIES if x not in policies]
        return Check(name, "PASS" if not missing else "MISSING", ", ".join(missing), SETUP_FIX)

    def secrets() -> Check:
        name = "Secret Manager secrets (names only)"
        if "secretmanager.googleapis.com" not in state["apis"]:
            return Check(
                name, "MISSING", f"{', '.join(SECRETS)}; {missing_api('secretmanager.googleapis.com')}", SETUP_FIX
            )
        missing = [s for s in SECRETS if gcloud(["secrets", "describe", s]).returncode != 0]
        return Check(name, "PASS" if not missing else "MISSING", ", ".join(missing), SETUP_FIX)

    def artifact_repo() -> Check:
        name = f"Artifact Registry repository {REPO}"
        if "artifactregistry.googleapis.com" not in state["apis"]:
            return Check(name, "MISSING", missing_api("artifactregistry.googleapis.com"), SETUP_FIX)
        res = gcloud(["artifacts", "repositories", "describe", REPO, f"--location={config.region}", "--format=json"])
        return Check(name, "PASS" if res.returncode == 0 else "MISSING", config.region, SETUP_FIX)

    def job() -> Check:
        if "run.googleapis.com" not in state["apis"]:
            return Check(f"Cloud Run Job {JOB}", "MISSING", missing_api("run.googleapis.com"), SETUP_FIX)
        res = gcloud(["run", "jobs", "describe", JOB, f"--region={config.region}", "--format=json"])
        if res.returncode != 0:
            return Check(f"Cloud Run Job {JOB}", "MISSING", config.region, SETUP_FIX)
        state["job"] = True
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
        if not state["job"]:
            return Check("last runner execution", "INFO", "checked once the job exists")
        res = gcloud(
            [
                "run",
                "jobs",
                "executions",
                "list",
                f"--job={JOB}",
                f"--region={config.region}",
                "--limit=1",
                "--format=json",
            ]
        )
        rows = json.loads(res.stdout or "[]")
        if not rows:
            return Check(
                "last runner execution", "INFO", "no executions yet (the first one comes with npm run prod:e2e)"
            )
        conditions = {c.get("type"): c.get("status") for c in rows[0].get("status", {}).get("conditions", [])}
        return Check(
            "last runner execution",
            "PASS" if conditions.get("Completed") == "True" else "FAIL",
            json.dumps(conditions),
            "gcloud run jobs executions describe (see logs)",
        )

    def billed() -> Check:
        name = "BigQuery bytes billed this month by peoplelake-* service accounts"
        if not state["service_accounts"]:
            return Check(name, "PASS", "0 bytes: no peoplelake-* service account exists yet (no query run)")
        b = read.month_billed()
        share = b / BQ_MONTHLY_BYTES_CAP
        return Check(
            name,
            "PASS" if share < 0.9 else "WARN",
            f"{b:,} bytes ({share:.1%} of the 275 GB monthly guard)",
            "the guard skips transforms past 275 GB; drills resume next month with --scenarios",
        )

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
        # Reported, not failed: the doctor must pass before the go-live that produces this evidence.
        return Check(
            "go-live evidence",
            "PASS" if not missing else "WARN",
            ", ".join(missing),
            f"README production setup step {README_STEP['go_live']}: npm run prod:e2e, then the BigQuery drill "
            "(eval scenarios --target prod-drill)",
        )

    for name, fn in (
        ("ADC", adc),
        ("project", project),
        ("billing", billing),
        ("APIs", apis),
        ("key policy", key_policy),
        ("service accounts", service_accounts),
        ("project roles", project_roles),
        ("build identity", build_identity),
        ("datasets", datasets),
        ("taxonomy", taxonomy),
        ("secrets", secrets),
        ("artifact registry", artifact_repo),
        ("job", job),
        ("execution", last_execution),
        ("billed bytes", billed),
        ("files", files),
        ("evidence", evidence),
    ):
        out.append(run_check(name, fn, "see README production setup"))
    return out
