"""bootstrap-gcp in plan mode against fake clients: the expected actions, no mutations, idempotent."""

import json
import subprocess
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import NotFound

from peoplelake.prod.bootstrap_gcp import (
    SERVICES,
    Bootstrap,
    Clients,
    Gcloud,
    GcpConfig,
    all_datasets,
    key_creation_blocked,
)


class FakeRunner:
    def __init__(self, exists: bool):
        self.exists = exists
        self.calls = []

    def __call__(self, argv, capture_output=True, text=True, check=False, input=None):
        self.calls.append(argv)
        joined = " ".join(argv)
        out = ""
        rc = 0 if self.exists else 1
        if "billing projects describe" in joined:
            rc, out = 0, "True"
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
    def __init__(self, exists: bool):
        self.exists = exists

    def get_dataset(self, ref):
        if not self.exists:
            raise NotFound(ref)
        name = ref.split(".")[1]
        hours = dict(all_datasets())[name]
        entries = [
            SimpleNamespace(entity_id="pl-runner@peoplelake-123.iam.gserviceaccount.com", role="OWNER"),
            SimpleNamespace(entity_id="pl-analyst@peoplelake-123.iam.gserviceaccount.com", role="READER"),
        ]
        return SimpleNamespace(max_time_travel_hours=hours, access_entries=entries)


class FakePolicyTags:
    def __init__(self, exists: bool):
        self.exists = exists

    def list_taxonomies(self, parent):
        return (
            [SimpleNamespace(display_name="peoplelake-sensitivity", name=f"{parent}/taxonomies/77")]
            if self.exists
            else []
        )

    def list_policy_tags(self, parent):
        return [
            SimpleNamespace(display_name=t, name=f"{parent}/policyTags/{t}") for t in ("compensation", "performance")
        ]


class FakeDataPolicies:
    def __init__(self, exists: bool):
        self.exists = exists

    def list_data_policies(self, parent):
        ids = ["pl_mask_compensation", "pl_mask_performance"] if self.exists else []
        return [SimpleNamespace(data_policy_id=i) for i in ids]


def bootstrap(tmp_path, monkeypatch, exists: bool):
    adc = tmp_path / "gcloud"
    adc.mkdir()
    (adc / "application_default_credentials.json").write_text(json.dumps({"quota_project_id": "peoplelake-123"}))
    monkeypatch.setenv("CLOUDSDK_CONFIG", str(adc))
    prod = tmp_path / ".prod"
    prod.mkdir()
    if exists:
        (prod / "gcp-dispatcher-key.json").write_text("{}")
    config = GcpConfig(
        project="peoplelake-123",
        owner_email="owner@example.com",
        workers_subdomain="nitish",
        catalog_uri="https://catalog.example",
        warehouse="acct_peoplelake-lake",
        secrets={
            "PL_R2_CATALOG_TOKEN": "token-value",
            "PL_CF_RUNNER_CLIENT_ID": "token-value",
            "PL_CF_RUNNER_CLIENT_SECRET": "token-value",
        },
    )
    runner = FakeRunner(exists)
    gcloud = Gcloud(plan=True, runner=runner, project=config.project)
    clients = Clients(
        bigquery=FakeBigQuery(exists), policy_tags=FakePolicyTags(exists), data_policies=FakeDataPolicies(exists)
    )
    boot = Bootstrap(config, gcloud, clients, prod_dir=prod, git_sha="abc123")
    return boot, runner, gcloud


def test_plan_on_an_empty_project_creates_everything_without_mutating(tmp_path, monkeypatch):
    boot, runner, gcloud = bootstrap(tmp_path, monkeypatch, exists=False)
    actions = boot.run()
    created = [(a.step, a.target) for a in actions if a.kind == "create"]
    assert sum(1 for s, _ in created if s == "datasets") == 12
    assert ("taxonomy", "peoplelake-sensitivity") in created
    assert {t for s, t in created if s == "data policies"} == {"pl_mask_compensation", "pl_mask_performance"}
    assert sum(1 for s, _ in created if s == "service accounts") == 3
    assert {t for s, t in created if s == "secrets"} == {
        "pl-r2-catalog-token",
        "pl-runner-client-id",
        "pl-runner-client-secret",
    }
    assert ("cloud run job", "peoplelake-runner") in created
    assert any(s == "dispatcher key" for s, _ in created)
    assert not any(a.kind == "fail" for a in actions)
    # Plan mode: only read-only gcloud commands ran.
    mutating = {"create", "deploy", "enable", "add-iam-policy-binding", "submit", "set-cleanup-policies", "add"}
    for argv in runner.calls:
        assert not mutating & set(argv), argv
    assert any("run jobs deploy peoplelake-runner" in m for m in gcloud.mutations)
    assert any("--data-file=-" in m and "secret on stdin" in m for m in gcloud.mutations)
    assert not any("token-value" in m for m in gcloud.mutations)  # secret values never in argv
    assert not (tmp_path / ".prod" / "gcp.json").exists()


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
