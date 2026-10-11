"""bootstrap-gcp in plan mode against fake clients: the expected actions, no mutations, idempotent."""

import json
import shutil
import subprocess
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound, PermissionDenied

from peoplelake.prod.bootstrap_gcp import (
    ALLOWED_PROJECT_ROLES,
    ANALYST_DATASETS,
    SERVICES,
    Bootstrap,
    Clients,
    Gcloud,
    GcpConfig,
    all_datasets,
    extra_project_roles,
    key_creation_blocked,
)


class FakeRunner:
    def __init__(self, exists: bool, billing: str = "True"):
        self.exists = exists
        self.billing = billing
        self.calls = []
        self.kwargs = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        self.kwargs.append(kwargs)
        joined = " ".join(argv)
        out = ""
        rc = 0 if self.exists else 1
        if "billing projects describe" in joined:
            rc, out = 0, self.billing
        elif "projects describe" in joined:
            rc, out = 0, ("" if "parent.type" in joined else "peoplelake-123")
        elif "services list" in joined:
            rc, out = 0, "\n".join(SERVICES if self.exists else ["bigquery.googleapis.com"])
        elif "get-default-service-account" in joined:
            rc, out = 0, "projects/peoplelake-123/serviceAccounts/123-compute@developer.gserviceaccount.com"
        elif "secrets versions access" in joined:
            rc, out = (0, "token-value") if self.exists else (1, "")
        return subprocess.CompletedProcess(argv, rc, out, "")


class FakeBigQuery:
    def __init__(self, exists: bool, sandbox_expiration: bool = False, analyst_also_on: tuple[str, ...] = ()):
        self.exists = exists
        self.sandbox_expiration = sandbox_expiration
        self.analyst_also_on = analyst_also_on

    def get_dataset(self, ref):
        if not self.exists:
            raise NotFound(ref)
        name = ref.split(".")[1]
        hours = dict(all_datasets())[name]
        entries = [SimpleNamespace(entity_id="peoplelake-runner@peoplelake-123.iam.gserviceaccount.com", role="OWNER")]
        if name in ANALYST_DATASETS or name in self.analyst_also_on:
            entries.append(
                SimpleNamespace(entity_id="peoplelake-analyst@peoplelake-123.iam.gserviceaccount.com", role="READER")
            )
        sixty_days = 60 * 24 * 3600 * 1000 if self.sandbox_expiration else None
        return SimpleNamespace(
            max_time_travel_hours=hours,
            access_entries=entries,
            labels={"app": "peoplelake", "drill": "true" if name.endswith("_drill") else "false"},
            default_table_expiration_ms=sixty_days,
            default_partition_expiration_ms=sixty_days,
        )


def service_disabled(api: str) -> PermissionDenied:
    """What the real clients raise when the project has not enabled the API (403 SERVICE_DISABLED)."""
    return PermissionDenied(
        f"{api} has not been used in project peoplelake-123 before or it is disabled. reason: SERVICE_DISABLED"
    )


class FakePolicyTags:
    """On an empty project the Data Catalog API is disabled (FakeRunner lists only BigQuery as enabled),
    so every read raises as the real client does."""

    def __init__(self, exists: bool):
        self.exists = exists

    def list_taxonomies(self, parent):
        if not self.exists:
            raise service_disabled("Data Catalog API")
        return (
            [SimpleNamespace(display_name="peoplelake-sensitivity", name=f"{parent}/taxonomies/77")]
            if self.exists
            else []
        )

    def list_policy_tags(self, parent):
        if not self.exists:
            raise service_disabled("Data Catalog API")
        return [
            SimpleNamespace(display_name=t, name=f"{parent}/policyTags/{t}") for t in ("compensation", "performance")
        ]


class FakeDataPolicies:
    def __init__(self, exists: bool):
        self.exists = exists

    def list_data_policies(self, parent):
        if not self.exists:
            raise service_disabled("BigQuery Data Policy API")
        ids = ["peoplelake_mask_compensation", "peoplelake_mask_performance"] if self.exists else []
        return [SimpleNamespace(data_policy_id=i) for i in ids]


def bootstrap(
    tmp_path, monkeypatch, exists: bool, billing: str = "True", sandbox_expiration: bool = False, catalog_uri: str = "x"
):
    monkeypatch.setattr("peoplelake.prod.adc.adc_quota_project", lambda: (True, "peoplelake-123"))
    prod = tmp_path / ".prod"
    prod.mkdir()
    if exists:
        (prod / "gcp-dispatcher-key.json").write_text("{}")
    config = GcpConfig(
        project="peoplelake-123",
        owner_email="owner@example.com",
        workers_subdomain="nitish",
        catalog_uri="https://catalog.example" if catalog_uri else "",
        warehouse="acct_peoplelake-lake",
        secrets={
            "PL_R2_CATALOG_TOKEN": "token-value",
            "PL_CF_RUNNER_CLIENT_ID": "token-value",
            "PL_CF_RUNNER_CLIENT_SECRET": "token-value",
        },
    )
    runner = FakeRunner(exists, billing)
    gcloud = Gcloud(plan=True, runner=runner, project=config.project)
    clients = Clients(
        bigquery=FakeBigQuery(exists, sandbox_expiration),
        policy_tags=FakePolicyTags(exists),
        data_policies=FakeDataPolicies(exists),
    )
    boot = Bootstrap(config, gcloud, clients, prod_dir=prod, git_sha="abc123")
    return boot, runner, gcloud


def test_plan_on_an_empty_project_creates_everything_without_mutating(tmp_path, monkeypatch):
    boot, runner, gcloud = bootstrap(tmp_path, monkeypatch, exists=False)
    actions = boot.run()
    created = [(a.step, a.target) for a in actions if a.kind == "create"]
    assert sum(1 for s, _ in created if s == "datasets") == 14
    assert ("taxonomy", "peoplelake-sensitivity") in created
    assert {t for s, t in created if s == "data policies"} == {
        "peoplelake_mask_compensation",
        "peoplelake_mask_performance",
    }
    assert sum(1 for s, _ in created if s == "service accounts") == 4
    assert {t for s, t in created if s == "secrets"} == {
        "peoplelake-r2-catalog-token",
        "peoplelake-runner-client-id",
        "peoplelake-runner-client-secret",
    }
    assert ("cloud run job", "peoplelake-runner") in created
    assert any(s == "dispatcher key" for s, _ in created)
    assert {t for s, t in created if s == "policy tags"} == {"compensation", "performance"}
    assert not any(a.kind == "fail" for a in actions)
    # The runner can read every secret the job is deployed with, including the ones created in this run.
    for secret in ("peoplelake-r2-catalog-token", "peoplelake-runner-client-id", "peoplelake-runner-client-secret"):
        bindings = [m for m in gcloud.mutations if f"secrets add-iam-policy-binding {secret} " in m]
        assert len(bindings) == 1, secret
        assert "--member=serviceAccount:peoplelake-runner@peoplelake-123.iam.gserviceaccount.com" in bindings[0]
        assert "--role=roles/secretmanager.secretAccessor" in bindings[0]
    job = gcloud.mutations.index(next(m for m in gcloud.mutations if "run jobs deploy" in m))
    assert max(i for i, m in enumerate(gcloud.mutations) if "secrets add-iam-policy-binding" in m) < job
    # Plan mode: only read-only gcloud commands ran.
    mutating = {"create", "deploy", "enable", "add-iam-policy-binding", "submit", "set-cleanup-policies", "add"}
    for argv in runner.calls:
        assert not mutating & set(argv), argv
    assert any("run jobs deploy peoplelake-runner" in m for m in gcloud.mutations)
    assert any("--data-file=-" in m and "secret on stdin" in m for m in gcloud.mutations)
    assert not any("token-value" in m for m in gcloud.mutations)  # secret values never in argv
    assert not (tmp_path / ".prod" / "gcp.json").exists()
    # Reads never prompt (gcloud would otherwise offer to enable a disabled API, a mutation in plan mode).
    for kwargs in runner.kwargs:
        assert kwargs["stdin"] is subprocess.DEVNULL
        assert kwargs["env"]["CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API"] == "false"
        assert kwargs["env"]["CLOUDSDK_CORE_DISABLE_PROMPTS"] == "1"


def test_the_plan_never_reads_through_an_api_the_project_has_not_enabled(tmp_path, monkeypatch):
    """The real project has 8 of the 11 APIs disabled: `--plan` must print the plan, not crash on a 403."""
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=False)

    class Untouchable:
        def __getattr__(self, name):
            raise AssertionError(f"plan read a disabled API: {name}")

    boot.clients.policy_tags = Untouchable()
    actions = boot.run()
    created = {(a.step, a.target) for a in actions if a.kind == "create"}
    assert ("taxonomy", "peoplelake-sensitivity") in created
    assert {("data policies", "peoplelake_mask_compensation"), ("data policies", "peoplelake_mask_performance")} <= (
        created
    )


def test_the_plan_survives_an_api_reported_enabled_that_still_refuses(tmp_path, monkeypatch):
    """`services list` can say enabled while the client still answers SERVICE_DISABLED (propagation)."""
    boot, runner, _ = bootstrap(tmp_path, monkeypatch, exists=False)
    original = runner.__call__

    def all_enabled(argv, **kwargs):
        if "services list" in " ".join(argv):
            return subprocess.CompletedProcess(argv, 0, "\n".join(SERVICES), "")
        return original(argv, **kwargs)

    boot.g.runner = all_enabled
    actions = boot.run()
    assert ("taxonomy", "peoplelake-sensitivity") in {(a.step, a.target) for a in actions if a.kind == "create"}


def test_outside_plan_mode_a_disabled_api_error_propagates(tmp_path, monkeypatch):
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=False)
    boot.g.plan = False
    with pytest.raises(PermissionDenied):
        boot.client_read("datacatalog.googleapis.com", lambda: boot.clients.policy_tags.list_taxonomies("p"))


def test_plan_on_a_complete_project_creates_nothing(tmp_path, monkeypatch):
    boot, _, gcloud = bootstrap(tmp_path, monkeypatch, exists=True)
    actions = boot.run()
    assert [a for a in actions if a.kind == "create"] == []
    assert not any(a.kind == "fail" for a in actions)
    assert not any("keys create" in m for m in gcloud.mutations)  # the key is never re-created


@pytest.mark.parametrize(
    ("policy", "blocked"),
    [
        ('{"booleanPolicy": {"enforced": true}}', True),
        ('{"spec": {"rules": [{"enforce": true}]}}', True),
        ('{"spec": {"rules": [{"enforce": false}]}}', False),
        ("{}", False),
    ],
)
def test_key_creation_policy_detection(policy, blocked):
    assert key_creation_blocked(policy) is blocked


def test_every_name_in_the_shared_project_starts_with_peoplelake(tmp_path, monkeypatch):
    boot, _, gcloud = bootstrap(tmp_path, monkeypatch, exists=False)
    actions = boot.run()
    for a in actions:
        if a.kind != "create" or a.step in ("services", "dispatcher key", "policy tags", "tag iam", "dataset access"):
            continue
        if a.step == "runner image":  # an image inside the `peoplelake` repository
            assert "/peoplelake-123/peoplelake/runner:" in a.target
            continue
        target = a.target.removeprefix("gs://").split("@")[0]
        name = target.split("/")[-1].split(":")[0].split(".")[-1]
        assert name.startswith("peoplelake"), (a.step, a.target)
    for m in gcloud.mutations:
        if " create " in f" {m} " and "keys create" not in m and "services" not in m:
            created = m.split(" create ", 1)[1].split()[0].removeprefix("gs://")
            assert created.startswith("peoplelake"), m


def test_the_only_project_level_roles_are_job_user_and_log_writer(tmp_path, monkeypatch):
    boot, runner, gcloud = bootstrap(tmp_path, monkeypatch, exists=False)
    boot.run()
    project_bindings = [m for m in gcloud.mutations if "projects add-iam-policy-binding" in m]
    granted = sorted((m.split("--member=")[1].split()[0], m.split("--role=")[1].split()[0]) for m in project_bindings)
    assert granted == [
        ("serviceAccount:peoplelake-analyst@peoplelake-123.iam.gserviceaccount.com", "roles/bigquery.jobUser"),
        ("serviceAccount:peoplelake-build@peoplelake-123.iam.gserviceaccount.com", "roles/logging.logWriter"),
        ("serviceAccount:peoplelake-runner@peoplelake-123.iam.gserviceaccount.com", "roles/bigquery.jobUser"),
    ]
    assert {role for _, role in granted} <= ALLOWED_PROJECT_ROLES
    # Nothing goes to the Cloud Build default service account; builds run as peoplelake-build.
    assert not any("get-default-service-account" in " ".join(argv) for argv in runner.calls)
    assert not any("cloudbuild.gserviceaccount.com" in m or "compute@developer" in m for m in gcloud.mutations)
    submit = next(m for m in gcloud.mutations if "builds submit" in m)
    assert (
        "--service-account=projects/peoplelake-123/serviceAccounts/peoplelake-build@peoplelake-123.iam.gserviceaccount.com"
        in submit
    )
    assert "--gcs-source-staging-dir=gs://peoplelake-build-peoplelake-123/source" in submit
    resource_scoped = [
        m for m in gcloud.mutations if "add-iam-policy-binding" in m and "projects add-iam-policy-binding" not in m
    ]
    assert any(
        "storage buckets add-iam-policy-binding gs://peoplelake-build-peoplelake-123" in m for m in resource_scoped
    )
    assert any("artifacts repositories add-iam-policy-binding peoplelake" in m for m in resource_scoped)


def test_doctor_flags_extra_project_roles():
    members = {"serviceAccount:peoplelake-runner@p.iam.gserviceaccount.com"}
    policy = {
        "bindings": [
            {"role": "roles/bigquery.jobUser", "members": list(members)},
            {
                "role": "roles/bigquery.dataViewer",
                "members": list(members) + ["serviceAccount:other@p.iam.gserviceaccount.com"],
            },
        ]
    }
    assert extra_project_roles(policy, members) == [
        "roles/bigquery.dataViewer for serviceAccount:peoplelake-runner@p.iam.gserviceaccount.com"
    ]


def test_datasets_get_no_default_expiration(tmp_path, monkeypatch):
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=True, sandbox_expiration=True)
    actions = boot.run()
    updated = [a for a in actions if a.step == "datasets" and a.kind == "update"]
    assert len(updated) == 14
    assert all(
        "default table expiration cleared" in a.detail and "default partition expiration cleared" in a.detail
        for a in updated
    )
    (tmp_path / "empty").mkdir()
    created = [a for a in bootstrap(tmp_path / "empty", monkeypatch, exists=False)[0].run() if a.step == "datasets"]
    assert all("no default expiration" in a.detail for a in created)


def test_the_plan_refuses_while_billing_is_disabled(tmp_path, monkeypatch):
    boot, _, gcloud = bootstrap(tmp_path, monkeypatch, exists=False, billing="False")
    actions = boot.run()
    assert {a.step for a in actions} == {"preflight"}
    assert any(a.kind == "fail" and a.target == "billing" for a in actions)
    assert gcloud.mutations == []


def test_config_reads_the_catalog_and_subdomain_from_the_state_setup_writes(tmp_path):
    """state.json has setup:prod's shape (scripts/lib/prod-state.ts): `catalog.uri`, `catalog.warehouse`."""
    from peoplelake.paths import repo_root

    prod = tmp_path / ".prod"
    prod.mkdir()
    shutil.copy(repo_root() / "scripts" / "fixtures" / "prod-state.example.json", prod / "state.json")
    (prod / "config.env").write_text("PL_GCP_PROJECT=peoplelake-123\nPL_WORKERS_SUBDOMAIN=configured\n")
    state = json.loads((prod / "state.json").read_text())
    config = GcpConfig.load(prod)
    assert config.catalog_uri == state["catalog"]["uri"] != ""
    assert config.warehouse == state["catalog"]["warehouse"] != ""
    # setup records the account's real subdomain, which wins over the configured one
    assert config.workers_subdomain == state["workers_subdomain"]
    (prod / "config.env").write_text("PL_GCP_PROJECT=p\nPL_R2_CATALOG_URI=https://override\nPL_R2_WAREHOUSE=w\n")
    assert (GcpConfig.load(prod).catalog_uri, GcpConfig.load(prod).warehouse) == ("https://override", "w")


def test_bootstrap_stops_before_a_runner_job_without_the_catalog(tmp_path, monkeypatch):
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=False, catalog_uri="")
    actions = boot.run()
    failed = [a for a in actions if a.kind == "fail"]
    assert [a.target for a in failed] == ["runner job settings"]
    assert "Basin Catalog URI" in failed[0].detail and "--only cloudflare" in failed[0].detail


def test_adc_quota_project_comes_from_google_auth(monkeypatch):
    from types import SimpleNamespace as NS

    import google.auth
    from google.auth.exceptions import DefaultCredentialsError

    from peoplelake.prod.adc import adc_quota_project

    monkeypatch.setattr(google.auth, "default", lambda: (NS(quota_project_id="q-1"), None))
    assert adc_quota_project() == (True, "q-1")
    monkeypatch.setattr(google.auth, "default", lambda: (NS(), None))
    assert adc_quota_project() == (True, None)

    def missing():
        raise DefaultCredentialsError("none")

    monkeypatch.setattr(google.auth, "default", missing)
    assert adc_quota_project() == (False, None)


def test_the_analyst_reads_the_view_datasets_only(tmp_path, monkeypatch):
    """dbt builds in peoplelake_restricted and leaves untagged __dbt_tmp copies there, so the analyst gets
    READER on peoplelake_reporting and peoplelake_restricted_access (views) and nothing else."""
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=False)
    grants = [a.target for a in boot.run() if a.step == "dataset access" and "analyst" in a.target]
    assert sorted(grants) == sorted(
        f"READER peoplelake-analyst@peoplelake-123.iam.gserviceaccount.com on {d}" for d in ANALYST_DATASETS
    )
    assert ANALYST_DATASETS == ("peoplelake_reporting", "peoplelake_restricted_access")


def test_an_analyst_entry_on_the_restricted_dataset_is_removed(tmp_path, monkeypatch):
    boot, _, _ = bootstrap(tmp_path, monkeypatch, exists=True)
    boot.clients.bigquery = FakeBigQuery(True, analyst_also_on=("peoplelake_restricted",))
    updates = [a for a in boot.run() if a.step == "dataset access" and a.kind == "update"]
    assert [a.target for a in updates] == [
        "peoplelake-analyst@peoplelake-123.iam.gserviceaccount.com removed from peoplelake_restricted"
    ]
