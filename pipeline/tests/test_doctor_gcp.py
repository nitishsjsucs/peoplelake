"""doctor-gcp against fake gcloud and Google clients: read only, and exact about what is missing."""

import json
import re
import subprocess
from types import SimpleNamespace

import pytest

from peoplelake.paths import repo_root
from peoplelake.prod.bootstrap_gcp import ANALYST_DATASETS, SERVICES, all_datasets
from peoplelake.prod.checks import Check, failed, summary
from peoplelake.prod.doctor_gcp import (
    GCLOUD_ENV,
    README_STEP,
    Readers,
    ReadOnlyGcloud,
    doctor,
    gcloud_read_only,
)
from peoplelake.warehouse.bigquery_wh import RESTRICTED_COLUMNS

PROJECT = "peoplelake-123"


class FakeGcloud:
    """Answers like a shared project before setup (`complete=False`) or after it (`complete=True`)."""

    def __init__(self, complete: bool, billing: str = "True", configured_project: str = PROJECT):
        self.complete = complete
        self.billing = billing
        self.configured_project = configured_project
        self.kwargs = []

    def __call__(self, argv, **kwargs):
        self.kwargs.append(kwargs)
        joined = " ".join(argv)
        rc, out = (0, "") if self.complete else (1, "")
        if "auth list" in joined:
            rc, out = 0, "owner@example.com"
        elif "config get-value project" in joined:
            rc, out = 0, self.configured_project
        elif "billing projects describe" in joined:
            rc, out = 0, self.billing
        elif "projects describe" in joined:
            rc, out = 0, ("" if "parent.type" in joined else PROJECT)
        elif "services list" in joined:
            rc, out = 0, "\n".join(SERVICES if self.complete else ["bigquery.googleapis.com", "iam.googleapis.com"])
        elif "get-iam-policy" in joined:
            rc, out = 0, json.dumps({"bindings": []})
        elif "run jobs describe" in joined and self.complete:
            out = json.dumps({"metadata": {"labels": {"git-sha": "0" * 40}}})
        elif "executions list" in joined:
            out = (
                json.dumps([{"status": {"conditions": [{"type": "Completed", "status": "True"}]}}])
                if self.complete
                else ""
            )
        return subprocess.CompletedProcess(argv, rc, out, "")


ANALYST = f"peoplelake-analyst@{PROJECT}.iam.gserviceaccount.com"
TAGS = {
    "compensation": "projects/p/locations/us/taxonomies/1/policyTags/c",
    "performance": "projects/p/locations/us/taxonomies/1/policyTags/p",
}


def fake_readers(
    complete: bool,
    quota: str | None = PROJECT,
    billed: list | None = None,
    analyst_on: tuple[str, ...] = ANALYST_DATASETS,
    untagged: tuple[str, ...] = (),
):
    def get_dataset(name):
        if not complete:
            return None
        entries = [SimpleNamespace(entity_id=ANALYST, role="READER")] if name in analyst_on else []
        return SimpleNamespace(
            max_time_travel_hours=dict(all_datasets())[name],
            default_table_expiration_ms=None,
            default_partition_expiration_ms=None,
            access_entries=entries,
        )

    def get_table(table_id):
        if not complete:
            return None
        table = table_id.split(".")[-1]
        fields = []
        for (t, column), tag in RESTRICTED_COLUMNS.items():
            if t == table:
                names = [] if column in untagged else [TAGS[tag]]
                fields.append(SimpleNamespace(name=column, policy_tags=SimpleNamespace(names=names)))
        return SimpleNamespace(schema=fields)

    def month_billed():
        if billed is not None:
            billed.append(1)
        return 3_000_000_000

    return lambda project, location: Readers(
        adc=lambda: (True, quota),
        get_dataset=get_dataset,
        get_table=get_table,
        taxonomies=lambda parent: ["peoplelake-sensitivity"] if complete else [],
        data_policies=lambda parent: (
            ["peoplelake_mask_compensation", "peoplelake_mask_performance"] if complete else []
        ),
        month_billed=month_billed,
    )


def run(
    tmp_path,
    complete: bool,
    *,
    billing: str = "True",
    env=None,
    config: str | None = None,
    billed=None,
    gcp_json: bool = False,
    **reader_options,
):
    prod = tmp_path / ".prod"
    prod.mkdir(parents=True, exist_ok=True)
    if config is not None:
        (prod / "config.env").write_text(config)
    if gcp_json:
        (prod / "gcp.json").write_text(json.dumps({"policy_tags": TAGS}))
    fake = FakeGcloud(complete, billing)
    gcloud = ReadOnlyGcloud(runner=fake)
    checks = doctor(
        prod,
        gcloud=gcloud,
        readers=fake_readers(complete, billed=billed, **reader_options),
        env=env if env is not None else {"PL_GCP_PROJECT": PROJECT},
        which=lambda _: "/usr/bin/gcloud",
    )
    return {c.name: c for c in checks}, checks, gcloud, fake


def test_every_gcloud_command_is_read_only_with_prompts_off(tmp_path):
    for complete in (False, True):
        _, _, gcloud, fake = run(tmp_path / str(complete), complete)
        assert gcloud.calls
        for argv in gcloud.calls:
            assert gcloud_read_only(argv[1:]), argv
            assert not {"create", "enable", "deploy", "add-iam-policy-binding", "delete", "update"} & set(argv)
        for kwargs in fake.kwargs:
            assert kwargs["stdin"] is subprocess.DEVNULL
            assert {k: kwargs["env"][k] for k in GCLOUD_ENV} == GCLOUD_ENV


def test_a_mutating_gcloud_command_is_refused():
    gcloud = ReadOnlyGcloud(runner=FakeGcloud(True))
    with pytest.raises(PermissionError, match="read-only"):
        gcloud(["services", "enable", "run.googleapis.com"])
    with pytest.raises(PermissionError):
        gcloud(["projects", "add-iam-policy-binding", PROJECT])
    assert gcloud.calls == []


def test_an_unprovisioned_sandbox_project_lists_exactly_what_is_missing(tmp_path):
    billed = []
    by, checks, _, _ = run(tmp_path, complete=False, billing="False", billed=billed)
    assert by["billing enabled"].status == "FAIL"
    assert f"step {README_STEP['billing']}" in by["billing enabled"].fix
    assert "gcloud billing projects link" in by["billing enabled"].fix
    apis = next(c for c in checks if c.name.startswith("APIs enabled"))
    assert apis.status == "MISSING" and "run.googleapis.com" in apis.detail and "iam.googleapis.com" not in apis.detail
    sas = next(c for c in checks if c.name.startswith("service accounts"))
    assert sas.name == "service accounts (0 of 4)" and sas.status == "MISSING"
    assert by["BigQuery datasets"].status == "MISSING" and "14" in by["BigQuery datasets"].detail
    assert by["policy tags and data masking"].status == "MISSING"
    assert "datacatalog.googleapis.com is not enabled" in by["policy tags and data masking"].detail
    assert by["Secret Manager secrets (names only)"].status == "MISSING"
    assert by["Artifact Registry repository peoplelake"].status == "MISSING"
    assert by["Cloud Run Job peoplelake-runner"].status == "MISSING"
    assert by["last runner execution"].status == "INFO"
    billed_check = by["BigQuery bytes billed this month by peoplelake-* service accounts"]
    assert billed_check.status == "PASS" and "no query run" in billed_check.detail
    assert billed == []  # nothing queried while no peoplelake-* account exists
    assert by["go-live evidence"].status == "WARN"
    assert not any(c.status == "UNKNOWN" for c in checks), [c for c in checks if c.status == "UNKNOWN"]
    assert failed(checks)


def test_a_complete_project_passes(tmp_path):
    billed = []
    by, checks, _, _ = run(tmp_path, complete=True, billed=billed)
    not_passing = {c.name: c.status for c in checks if c.status not in ("PASS", "INFO", "WARN")}
    assert not_passing == {}
    assert billed == [1]
    assert by["BigQuery datasets, time travel, no default expiration"].detail == "14 datasets"
    assert not failed(checks)


def test_without_config_the_project_comes_from_gcloud_and_is_reported_missing(tmp_path):
    by, _, _, _ = run(tmp_path, complete=False, env={})
    project = by["Google Cloud project"]
    assert project.status == "MISSING" and f"checking {PROJECT} from gcloud config" in project.detail
    assert f"step {README_STEP['prod_files']}" in project.fix
    assert by["billing enabled"].status == "PASS"  # the remaining checks still ran against that project


def test_config_env_supplies_the_project(tmp_path):
    by, _, gcloud, _ = run(
        tmp_path, complete=True, env={}, config="PL_GCP_PROJECT=from-file\nPL_GCP_REGION=europe-west1\n"
    )
    assert by["Google Cloud project"].status == "PASS"
    assert any(argv[-2:] == ["--project", "from-file"] for argv in gcloud.calls)
    assert any("--region=europe-west1" in argv for argv in gcloud.calls)


def test_the_cited_readme_steps_are_the_right_ones():
    readme = (repo_root() / "README.md").read_text()
    section = readme.split("### Steps only a person can do", 1)[1].split("\n### ", 1)[0]
    steps = {int(m.group(1)): m.group(2) for m in re.finditer(r"^\s*(\d+)\. (.+)$", section, re.MULTILINE)}
    assert "billing" in steps[README_STEP["billing"]].lower()
    assert "set-quota-project" in steps[README_STEP["quota_project"]]
    assert ".prod/config.env" in steps[README_STEP["prod_files"]]
    assert "setup:prod" in steps[README_STEP["setup"]]
    assert "Go live" in steps[README_STEP["go_live"]]


def test_summary_groups_what_is_not_passing_by_fix():
    checks = [
        Check("a", "PASS"),
        Check("b", "MISSING", fix="npm run setup:prod (README production setup step 8)"),
        Check("c", "FAIL", fix="README production setup step 4: link billing"),
        Check("d", "MISSING", fix="npm run setup:prod (README production setup step 8)"),
        Check("e", "INFO", "later"),
        Check("f", "WARN", fix="chmod 600"),
    ]
    assert summary(checks) == [
        "6 checks: 1 pass, 1 fail, 2 missing, 1 warn, 1 info",
        "Not passing, grouped by fix in README step order:",
        "  README production setup step 4: link billing",
        "    - c (FAIL)",
        "  npm run setup:prod (README production setup step 8)",
        "    - b (MISSING)",
        "    - d (MISSING)",
        "  chmod 600",
        "    - f (WARN)",
    ]
    assert failed(checks) and not failed([Check("x", "WARN"), Check("y", "INFO")])


def test_the_analyst_reads_views_only_and_restricted_columns_carry_their_tags(tmp_path):
    by_name, _, _, _ = run(tmp_path / "ok", True, gcp_json=True)
    assert by_name["peoplelake-analyst dataset grants (views only)"].status == "PASS"
    assert by_name["policy tags on the restricted columns"].status == "PASS"
    loose, _, _, _ = run(tmp_path / "loose", True, analyst_on=(*ANALYST_DATASETS, "peoplelake_restricted"))
    assert loose["peoplelake-analyst dataset grants (views only)"].status == "FAIL"
    assert (
        "unexpected READER on peoplelake_restricted" in loose["peoplelake-analyst dataset grants (views only)"].detail
    )
    bare, _, _, _ = run(tmp_path / "bare", True, gcp_json=True, untagged=("bonus_target_pct",))
    tags = bare["policy tags on the restricted columns"]
    assert (
        tags.status == "FAIL" and tags.detail == "fct_compensation_history.bonus_target_pct lacks the compensation tag"
    )
    before, _, _, _ = run(tmp_path / "before", False)
    assert before["policy tags on the restricted columns"].status == "INFO"
