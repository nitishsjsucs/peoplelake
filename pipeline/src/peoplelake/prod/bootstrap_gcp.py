"""`peoplelake prod bootstrap-gcp` (SPEC 21.2): every Google Cloud resource, check then create, idempotent.

Reads `.prod/config.env`, `.prod/secrets.env` and `.prod/state.json` (written by `npm run setup:prod`),
writes `.prod/gcp.json` and `.prod/gcp-dispatcher-key.json` (mode 600). `--plan` runs only the read-only
checks and prints every mutation it would make. Secret values go to gcloud on stdin, never in argv, and
are never printed.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..envfile import read_env_file
from ..paths import repo_root

SERVICES = (
    "bigquery.googleapis.com",
    "bigquerystorage.googleapis.com",
    "datacatalog.googleapis.com",
    "bigquerydatapolicy.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
)
# Dataset -> max time travel hours (BigQuery accepts 48..168).
DATASETS: dict[str, int] = {
    "pl_raw": 48,
    "pl_staging": 48,
    "pl_ops": 48,
    "pl_core": 168,
    "pl_restricted": 168,
    "pl_reporting": 168,
}
TAXONOMY = "peoplelake-sensitivity"
TAGS = ("compensation", "performance")
DATA_POLICIES = {
    "pl_mask_compensation": ("compensation", "DEFAULT_MASKING_VALUE"),
    "pl_mask_performance": ("performance", "ALWAYS_NULL"),
}
SECRETS = {
    "pl-r2-catalog-token": "PL_R2_CATALOG_TOKEN",
    "pl-runner-client-id": "PL_CF_RUNNER_CLIENT_ID",
    "pl-runner-client-secret": "PL_CF_RUNNER_CLIENT_SECRET",
}
JOB = "peoplelake-runner"
REPO = "peoplelake"


def all_datasets() -> list[tuple[str, int]]:
    return [(d, h) for d, h in DATASETS.items()] + [(f"{d}_drill", h) for d, h in DATASETS.items()]


def key_creation_blocked(policy_json: str) -> bool:
    """True when the effective org policy enforces iam.managed.disableServiceAccountKeyCreation."""
    try:
        policy = json.loads(policy_json or "{}")
    except json.JSONDecodeError:
        return False
    if policy.get("booleanPolicy", {}).get("enforced"):
        return True
    rules = policy.get("spec", policy).get("rules", [])
    return any(r.get("enforce") is True or r.get("enforce") == "TRUE" for r in rules)


@dataclass
class GcpConfig:
    project: str
    region: str = "us-central1"
    bq_location: str = "US"
    owner_email: str = ""
    workers_subdomain: str = ""
    catalog_uri: str = ""
    warehouse: str = ""
    secrets: dict[str, str] = field(default_factory=dict)

    @property
    def runner_sa(self) -> str:
        return f"pl-runner@{self.project}.iam.gserviceaccount.com"

    @property
    def analyst_sa(self) -> str:
        return f"pl-analyst@{self.project}.iam.gserviceaccount.com"

    @property
    def dispatcher_sa(self) -> str:
        return f"pl-dispatcher@{self.project}.iam.gserviceaccount.com"

    @property
    def worker_url(self) -> str:
        return f"https://peoplelake.{self.workers_subdomain}.workers.dev"

    @property
    def image_repo(self) -> str:
        return f"{self.region}-docker.pkg.dev/{self.project}/{REPO}/runner"

    @classmethod
    def load(cls, prod_dir: Path) -> GcpConfig:
        config = read_env_file(prod_dir / "config.env")
        secrets = read_env_file(prod_dir / "secrets.env")
        state = json.loads((prod_dir / "state.json").read_text()) if (prod_dir / "state.json").exists() else {}
        project = config.get("PL_GCP_PROJECT", "")
        if not project:
            raise SystemExit("PL_GCP_PROJECT is missing from .prod/config.env")
        return cls(
            project=project,
            region=config.get("PL_GCP_REGION", "us-central1"),
            bq_location=config.get("PL_BQ_LOCATION", "US"),
            owner_email=config.get("PL_OWNER_EMAIL", ""),
            workers_subdomain=config.get("PL_WORKERS_SUBDOMAIN", state.get("workers_subdomain", "")),
            catalog_uri=state.get("catalog_uri", config.get("PL_R2_CATALOG_URI", "")),
            warehouse=state.get("warehouse", config.get("PL_R2_WAREHOUSE", "")),
            secrets=secrets,
        )


@dataclass
class Action:
    step: str
    kind: str  # exists | create | update | check | skip | fail
    target: str
    detail: str = ""


Runner = Callable[..., subprocess.CompletedProcess]


class Gcloud:
    """gcloud wrapper: reads always run; mutations are recorded and run only outside plan mode."""

    def __init__(self, plan: bool, runner: Runner = subprocess.run, project: str | None = None) -> None:
        self.plan = plan
        self.runner = runner
        self.project = project
        self.mutations: list[str] = []

    def _argv(self, args: list[str]) -> list[str]:
        argv = ["gcloud", *args]
        if self.project and "--project" not in " ".join(args):
            argv += ["--project", self.project]
        return argv

    def read(self, args: list[str]) -> subprocess.CompletedProcess:
        return self.runner(self._argv(args), capture_output=True, text=True, check=False)

    def ok(self, args: list[str]) -> bool:
        return self.read(args).returncode == 0

    def mutate(self, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess | None:
        argv = self._argv(args)
        self.mutations.append(" ".join(argv) + (" < (secret on stdin)" if stdin is not None else ""))
        if self.plan:
            return None
        res = self.runner(argv, input=stdin, capture_output=True, text=True, check=False)
        if res.returncode != 0:
            raise RuntimeError(f"{' '.join(argv[:6])} failed: {res.stderr.strip()[:500]}")
        return res


@dataclass
class Clients:
    bigquery: Any
    policy_tags: Any
    data_policies: Any


def real_clients(config: GcpConfig) -> Clients:
    from google.cloud import bigquery, bigquery_datapolicies_v1, datacatalog_v1

    return Clients(
        bigquery=bigquery.Client(project=config.project, location=config.bq_location),
        policy_tags=datacatalog_v1.PolicyTagManagerClient(),
        data_policies=bigquery_datapolicies_v1.DataPolicyServiceClient(),
    )


class Bootstrap:
    def __init__(
        self, config: GcpConfig, gcloud: Gcloud, clients: Clients, *, prod_dir: Path, git_sha: str | None = None
    ) -> None:
        self.c = config
        self.g = gcloud
        self.clients = clients
        self.prod_dir = prod_dir
        self.git_sha = git_sha
        self.actions: list[Action] = []
        self.tags: dict[str, str] = {}
        self.taxonomy: str | None = None

    def act(self, step: str, kind: str, target: str, detail: str = "") -> None:
        self.actions.append(Action(step, kind, target, detail))

    # 1 ------------------------------------------------------------------------------------------------
    def preflight(self) -> None:
        p = self.c.project
        if not self.g.ok(["projects", "describe", p, "--format=value(projectId)"]):
            self.act("preflight", "fail", f"project {p}", "gcloud projects create (README production setup, step 10)")
            return
        billing = self.g.read(["billing", "projects", "describe", p, "--format=value(billingEnabled)"]).stdout.strip()
        self.act(
            "preflight",
            "check" if billing.lower() == "true" else "fail",
            "billing",
            f"billingEnabled={billing or 'unknown'}",
        )
        adc = (
            Path(os.environ.get("CLOUDSDK_CONFIG", Path.home() / ".config" / "gcloud"))
            / "application_default_credentials.json"
        )
        quota = json.loads(adc.read_text()).get("quota_project_id") if adc.exists() else None
        self.act("preflight", "check" if quota == p else "fail", "ADC quota project", f"quota_project_id={quota}")
        parent = self.g.read(["projects", "describe", p, "--format=value(parent.type)"]).stdout.strip()
        if parent == "organization":
            policy = self.g.read(
                [
                    "resource-manager",
                    "org-policies",
                    "describe",
                    "iam.managed.disableServiceAccountKeyCreation",
                    "--effective",
                    "--format=json",
                ]
            ).stdout
            enforced = key_creation_blocked(policy)
            self.act(
                "preflight",
                "fail" if enforced else "check",
                "service account key creation",
                "blocked by organization policy" if enforced else "allowed",
            )
        else:
            self.act("preflight", "check", "organization", "none (key creation allowed)")

    # 2 ------------------------------------------------------------------------------------------------
    def services(self) -> None:
        enabled = set(self.g.read(["services", "list", "--enabled", "--format=value(config.name)"]).stdout.split())
        missing = [s for s in SERVICES if s not in enabled]
        if missing:
            self.g.mutate(["services", "enable", *missing])
            self.act("services", "create", ", ".join(missing))
        else:
            self.act("services", "exists", f"{len(SERVICES)} APIs enabled")

    # 3 ------------------------------------------------------------------------------------------------
    def datasets(self) -> None:
        from google.api_core.exceptions import NotFound
        from google.cloud import bigquery

        bq = self.clients.bigquery
        for name, hours in all_datasets():
            ref = f"{self.c.project}.{name}"
            try:
                ds = bq.get_dataset(ref)
            except NotFound:
                if not self.g.plan:
                    ds = bigquery.Dataset(ref)
                    ds.location = self.c.bq_location
                    ds.max_time_travel_hours = hours
                    ds.labels = {"app": "peoplelake", "drill": "true" if name.endswith("_drill") else "false"}
                    bq.create_dataset(ds)
                self.act("datasets", "create", ref, f"location {self.c.bq_location}, time travel {hours} h")
                continue
            if ds.max_time_travel_hours != hours:
                if not self.g.plan:
                    ds.max_time_travel_hours = hours
                    bq.update_dataset(ds, ["max_time_travel_hours"])
                self.act("datasets", "update", ref, f"time travel {ds.max_time_travel_hours} -> {hours} h")
            else:
                self.act("datasets", "exists", ref)

    # 4 ------------------------------------------------------------------------------------------------
    def taxonomy_and_policies(self) -> None:
        parent = f"projects/{self.c.project}/locations/us"
        ptm = self.clients.policy_tags
        found = next((t for t in ptm.list_taxonomies(parent=parent) if t.display_name == TAXONOMY), None)
        if found is None:
            if self.g.plan:
                self.act("taxonomy", "create", TAXONOMY, "FINE_GRAINED_ACCESS_CONTROL")
                self.taxonomy = f"{parent}/taxonomies/(new)"
            else:
                from google.cloud import datacatalog_v1

                found = ptm.create_taxonomy(
                    parent=parent,
                    taxonomy=datacatalog_v1.Taxonomy(
                        display_name=TAXONOMY,
                        activated_policy_types=[datacatalog_v1.Taxonomy.PolicyType.FINE_GRAINED_ACCESS_CONTROL],
                    ),
                )
                self.act("taxonomy", "create", found.name)
        else:
            self.act("taxonomy", "exists", found.name)
        if found is not None:
            self.taxonomy = found.name
            existing = {t.display_name: t.name for t in ptm.list_policy_tags(parent=found.name)}
            for tag in TAGS:
                if tag in existing:
                    self.tags[tag] = existing[tag]
                    self.act("policy tags", "exists", existing[tag])
                elif self.g.plan:
                    self.tags[tag] = f"{found.name}/policyTags/({tag})"
                    self.act("policy tags", "create", tag)
                else:
                    from google.cloud import datacatalog_v1

                    created = ptm.create_policy_tag(
                        parent=found.name, policy_tag=datacatalog_v1.PolicyTag(display_name=tag)
                    )
                    self.tags[tag] = created.name
                    self.act("policy tags", "create", created.name)
        else:
            for tag in TAGS:
                self.tags[tag] = f"(new)/policyTags/({tag})"
                self.act("policy tags", "create", tag)
        dps = self.clients.data_policies
        have = {p.data_policy_id for p in dps.list_data_policies(parent=parent)}
        for policy_id, (tag, expression) in DATA_POLICIES.items():
            if policy_id in have:
                self.act("data policies", "exists", policy_id)
                continue
            if not self.g.plan:
                from google.cloud import bigquery_datapolicies_v1 as dp

                dps.create_data_policy(
                    parent=parent,
                    data_policy=dp.DataPolicy(
                        data_policy_id=policy_id,
                        policy_tag=self.tags[tag],
                        data_policy_type=dp.DataPolicy.DataPolicyType.DATA_MASKING_POLICY,
                        data_masking_policy=dp.DataMaskingPolicy(
                            predefined_expression=getattr(dp.DataMaskingPolicy.PredefinedExpression, expression)
                        ),
                    ),
                )
            self.act("data policies", "create", policy_id, f"{expression} on {tag}")

    # 5 ------------------------------------------------------------------------------------------------
    def service_accounts(self) -> None:
        p = self.c.project
        for name, title in (
            ("pl-runner", "PeopleLake runner"),
            ("pl-analyst", "PeopleLake analyst"),
            ("pl-dispatcher", "PeopleLake dispatcher"),
        ):
            email = f"{name}@{p}.iam.gserviceaccount.com"
            if self.g.ok(["iam", "service-accounts", "describe", email]):
                self.act("service accounts", "exists", email)
            else:
                self.g.mutate(["iam", "service-accounts", "create", name, f"--display-name={title}"])
                self.act("service accounts", "create", email)
        for member, role in (
            (self.c.runner_sa, "roles/bigquery.jobUser"),
            (self.c.analyst_sa, "roles/bigquery.jobUser"),
        ):
            self.g.mutate(
                [
                    "projects",
                    "add-iam-policy-binding",
                    p,
                    f"--member=serviceAccount:{member}",
                    f"--role={role}",
                    "--condition=None",
                    "--quiet",
                ]
            )
            self.act("iam", "update", f"{role} for {member}", "project binding (idempotent)")
        if self.c.owner_email:
            for sa in (self.c.runner_sa, self.c.analyst_sa):
                self.g.mutate(
                    [
                        "iam",
                        "service-accounts",
                        "add-iam-policy-binding",
                        sa,
                        f"--member=user:{self.c.owner_email}",
                        "--role=roles/iam.serviceAccountTokenCreator",
                        "--quiet",
                    ]
                )
                self.act(
                    "iam",
                    "update",
                    f"serviceAccountTokenCreator on {sa}",
                    f"for {self.c.owner_email} (drills, masking demo)",
                )

    def dataset_access(self) -> None:
        from google.api_core.exceptions import NotFound
        from google.cloud import bigquery

        bq = self.clients.bigquery
        grants = [(name, self.c.runner_sa, "OWNER") for name, _ in all_datasets()]
        grants += [("pl_reporting", self.c.analyst_sa, "READER"), ("pl_restricted", self.c.analyst_sa, "READER")]
        for name, email, role in grants:
            ref = f"{self.c.project}.{name}"
            try:
                ds = bq.get_dataset(ref)
            except NotFound:
                self.act("dataset access", "create", f"{role} {email} on {name}", "after the dataset exists")
                continue
            if any(e.entity_id == email and e.role == role for e in ds.access_entries):
                self.act("dataset access", "exists", f"{role} {email} on {name}")
                continue
            if not self.g.plan:
                ds.access_entries = [
                    *ds.access_entries,
                    bigquery.AccessEntry(role=role, entity_type="userByEmail", entity_id=email),
                ]
                bq.update_dataset(ds, ["access_entries"])
            self.act("dataset access", "create", f"{role} {email} on {name}")

    def tag_and_policy_iam(self) -> None:
        for tag in TAGS:
            name = self.tags.get(tag, "")
            if "(" in name:
                self.act("tag iam", "create", f"categoryFineGrainedReader on {tag}", "after the tag exists")
                continue
            self.g.mutate(
                [
                    "data-catalog",
                    "taxonomies",
                    "policy-tags",
                    "add-iam-policy-binding",
                    name.split("/")[-1],
                    f"--taxonomy={name.split('/')[-3]}",
                    "--location=us",
                    f"--member=serviceAccount:{self.c.runner_sa}",
                    "--role=roles/datacatalog.categoryFineGrainedReader",
                ]
            )
            self.act("tag iam", "update", f"categoryFineGrainedReader on {tag}", self.c.runner_sa)
        if self.taxonomy and "(" not in self.taxonomy:
            self.g.mutate(
                [
                    "data-catalog",
                    "taxonomies",
                    "add-iam-policy-binding",
                    self.taxonomy.split("/")[-1],
                    "--location=us",
                    f"--member=serviceAccount:{self.c.runner_sa}",
                    "--role=roles/datacatalog.viewer",
                ]
            )
            self.act("tag iam", "update", "datacatalog.viewer on taxonomy", self.c.runner_sa)
        dps = self.clients.data_policies
        for policy_id in DATA_POLICIES:
            resource = f"projects/{self.c.project}/locations/us/dataPolicies/{policy_id}"
            if self.g.plan:
                self.act("data policy iam", "update", f"maskedReader on {policy_id}", self.c.analyst_sa)
                continue
            policy = dps.get_iam_policy(request={"resource": resource})
            member = f"serviceAccount:{self.c.analyst_sa}"
            role = "roles/bigquerydatapolicy.maskedReader"
            if any(b.role == role and member in b.members for b in policy.bindings):
                self.act("data policy iam", "exists", f"maskedReader on {policy_id}")
                continue
            policy.bindings.add(role=role, members=[member])
            dps.set_iam_policy(request={"resource": resource, "policy": policy})
            self.act("data policy iam", "update", f"maskedReader on {policy_id}", self.c.analyst_sa)

    # 6 ------------------------------------------------------------------------------------------------
    def secrets(self) -> None:
        for secret, env_name in SECRETS.items():
            value = self.c.secrets.get(env_name, "")
            if not value:
                self.act("secrets", "fail", secret, f"{env_name} missing from .prod/secrets.env")
                continue
            if not self.g.ok(["secrets", "describe", secret]):
                self.g.mutate(
                    ["secrets", "create", secret, "--replication-policy=automatic", "--data-file=-"], stdin=value
                )
                self.act("secrets", "create", secret)
                continue
            current = self.g.read(["secrets", "versions", "access", "latest", f"--secret={secret}"])
            if current.returncode == 0 and current.stdout == value:
                self.act("secrets", "exists", secret, "latest version current")
            else:
                self.g.mutate(["secrets", "versions", "add", secret, "--data-file=-"], stdin=value)
                self.act("secrets", "update", secret, "new version")
            self.g.mutate(
                [
                    "secrets",
                    "add-iam-policy-binding",
                    secret,
                    f"--member=serviceAccount:{self.c.runner_sa}",
                    "--role=roles/secretmanager.secretAccessor",
                    "--quiet",
                ]
            )

    # 7, 8 ---------------------------------------------------------------------------------------------
    def artifact_registry_and_build(self) -> str:
        if self.g.ok(["artifacts", "repositories", "describe", REPO, f"--location={self.c.region}"]):
            self.act("artifact registry", "exists", REPO)
        else:
            self.g.mutate(
                [
                    "artifacts",
                    "repositories",
                    "create",
                    REPO,
                    "--repository-format=docker",
                    f"--location={self.c.region}",
                ]
            )
            self.act("artifact registry", "create", REPO)
        policy = repo_root() / "infra" / "gcp" / "cleanup-policy.json"
        self.g.mutate(
            [
                "artifacts",
                "repositories",
                "set-cleanup-policies",
                REPO,
                f"--location={self.c.region}",
                f"--policy={policy}",
                "--no-dry-run",
            ]
        )
        builder = self.g.read(
            ["builds", "get-default-service-account", "--format=value(serviceAccountEmail)"]
        ).stdout.strip()
        builder = builder.split("/")[-1] if builder else ""
        if builder:
            for role in ("roles/artifactregistry.writer", "roles/logging.logWriter", "roles/storage.objectViewer"):
                self.g.mutate(
                    [
                        "projects",
                        "add-iam-policy-binding",
                        self.c.project,
                        f"--member=serviceAccount:{builder}",
                        f"--role={role}",
                        "--condition=None",
                        "--quiet",
                    ]
                )
            self.act(
                "cloud build",
                "update",
                f"roles for {builder}",
                "artifactregistry.writer, logging.logWriter, storage.objectViewer",
            )
        sha = self.git_sha or "unknown"
        image = f"{self.c.image_repo}:{sha}"
        dirty = subprocess.run(
            ["git", "status", "--porcelain"], cwd=repo_root(), capture_output=True, text=True
        ).stdout.strip()
        if dirty and not self.g.plan:
            raise RuntimeError("refusing to build the runner image from a dirty working tree")
        if self.g.ok(["artifacts", "docker", "images", "describe", image]):
            self.act("runner image", "exists", image)
        else:
            self.g.mutate(
                [
                    "builds",
                    "submit",
                    str(repo_root()),
                    "--config",
                    str(repo_root() / "infra" / "gcp" / "cloudbuild.yaml"),
                    f"--substitutions=_IMAGE={image}",
                    f"--region={self.c.region}",
                ]
            )
            self.act("runner image", "create", image, "Cloud Build")
        return image

    # 9 ------------------------------------------------------------------------------------------------
    def run_job(self, image: str) -> None:
        env = {
            "TZ": "UTC",
            "PL_TARGET": "prod",
            "PL_PROFILE": "full",
            "PL_WORKER_URL": self.c.worker_url,
            "PL_GCP_PROJECT": self.c.project,
            "PL_BQ_LOCATION": self.c.bq_location,
            "PL_R2_CATALOG_URI": self.c.catalog_uri,
            "PL_R2_WAREHOUSE": self.c.warehouse,
            "PL_PT_COMPENSATION": self.tags.get("compensation", ""),
            "PL_PT_PERFORMANCE": self.tags.get("performance", ""),
        }
        secrets = "PL_R2_CATALOG_TOKEN=pl-r2-catalog-token:latest,PL_CF_ACCESS_CLIENT_ID=pl-runner-client-id:latest,PL_CF_ACCESS_CLIENT_SECRET=pl-runner-client-secret:latest"
        exists = self.g.ok(["run", "jobs", "describe", JOB, f"--region={self.c.region}"])
        self.g.mutate(
            [
                "run",
                "jobs",
                "deploy",
                JOB,
                f"--image={image}",
                f"--region={self.c.region}",
                f"--service-account={self.c.runner_sa}",
                "--tasks=1",
                "--max-retries=0",
                "--task-timeout=45m",
                "--cpu=1",
                "--memory=2Gi",
                "--set-env-vars=" + ",".join(f"{k}={v}" for k, v in env.items()),
                f"--set-secrets={secrets}",
                "--args=runner,run,--until-idle,15,--target,prod",
                f"--labels=git-sha={(self.git_sha or 'unknown')[:40]}",
            ]
        )
        self.act("cloud run job", "update" if exists else "create", JOB, image)
        self.g.mutate(
            [
                "run",
                "jobs",
                "add-iam-policy-binding",
                JOB,
                f"--region={self.c.region}",
                f"--member=serviceAccount:{self.c.dispatcher_sa}",
                "--role=roles/run.jobsExecutor",
            ]
        )
        self.act("iam", "update", f"run.jobsExecutor on {JOB}", self.c.dispatcher_sa)
        key = self.prod_dir / "gcp-dispatcher-key.json"
        if key.exists():
            self.act("dispatcher key", "exists", str(key), "never re-created while it exists")
        else:
            self.g.mutate(
                ["iam", "service-accounts", "keys", "create", str(key), f"--iam-account={self.c.dispatcher_sa}"]
            )
            if not self.g.plan and key.exists():
                os.chmod(key, 0o600)
            self.act("dispatcher key", "create", str(key), "mode 600")

    # 10 -----------------------------------------------------------------------------------------------
    def write_state(self, image: str) -> None:
        state = {
            "project": self.c.project,
            "region": self.c.region,
            "bq_location": self.c.bq_location,
            "service_accounts": {
                "runner": self.c.runner_sa,
                "analyst": self.c.analyst_sa,
                "dispatcher": self.c.dispatcher_sa,
            },
            "taxonomy": self.taxonomy,
            "policy_tags": self.tags,
            "data_policies": list(DATA_POLICIES),
            "image": image,
            "job": JOB,
            "passed": not any(a.kind == "fail" for a in self.actions),
        }
        if self.g.plan:
            return
        path = self.prod_dir / "gcp.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(state, indent=2) + "\n")

    def run(self) -> list[Action]:
        self.preflight()
        if any(a.kind == "fail" for a in self.actions) and not self.g.plan:
            return self.actions
        self.services()
        self.datasets()
        self.taxonomy_and_policies()
        self.service_accounts()
        self.dataset_access()
        self.tag_and_policy_iam()
        self.secrets()
        image = self.artifact_registry_and_build()
        self.run_job(image)
        self.write_state(image)
        return self.actions


def git_head() -> str | None:
    res = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_root(), capture_output=True, text=True)
    return res.stdout.strip() or None


def main(plan: bool, prod_dir: Path | None = None) -> int:
    prod_dir = prod_dir or repo_root() / ".prod"
    config = GcpConfig.load(prod_dir)
    gcloud = Gcloud(plan=plan, project=config.project)
    boot = Bootstrap(config, gcloud, real_clients(config), prod_dir=prod_dir, git_sha=git_head())
    for a in boot.run():
        print(f"{a.kind.upper():7} {a.step}: {a.target}{' (' + a.detail + ')' if a.detail else ''}")
    if plan:
        print("\nPlanned gcloud mutations:")
        for m in gcloud.mutations:
            print(f"  {m}")
    failed = [a for a in boot.actions if a.kind == "fail"]
    return 1 if failed else 0
