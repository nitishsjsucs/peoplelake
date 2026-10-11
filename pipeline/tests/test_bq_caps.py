"""Shared Google Cloud project rules (SPEC 29.4.6): every query capped at 1 GB billed and labeled
app=peoplelake, one way to make a BigQuery client, dbt profiles capped, and no `pl_` dataset names left."""

from __future__ import annotations

import re
import subprocess

import yaml

from peoplelake.budget import BQ_LABELS, BQ_MAX_BYTES_BILLED, BQ_MONTHLY_BYTES_CAP, BQ_TRANSFORM_RESERVE_BYTES
from peoplelake.paths import repo_root
from peoplelake.warehouse.bigquery_wh import BigQueryWarehouse, bigquery_client


def test_bigquery_client_caps_and_labels_every_query_by_default():
    from google.auth.credentials import AnonymousCredentials

    client = bigquery_client("peoplelake-test", "US", credentials=AnonymousCredentials())
    default = client.default_query_job_config
    assert default.maximum_bytes_billed == BQ_MAX_BYTES_BILLED <= 1_000_000_000
    assert default.labels == {"app": "peoplelake"} == BQ_LABELS


def test_the_warehouse_caps_and_labels_each_query_it_runs():
    seen = []

    class Job:
        total_bytes_billed = 10_485_760
        num_dml_affected_rows = 0

        def result(self):
            return [{"m": None}]

    class Client:
        def query(self, sql, job_config=None, location=None):
            seen.append(job_config)
            return Job()

    BigQueryWarehouse(Client(), "p").max_load_seq("peoplelake_raw", "raw_event_deliveries")
    BigQueryWarehouse(Client(), "p").ensure_raw()
    assert len(seen) == 3
    assert all(c.maximum_bytes_billed <= 1_000_000_000 and c.labels.get("app") == "peoplelake" for c in seen)


def test_no_other_bigquery_client_construction_in_pipeline_src():
    src = repo_root() / "pipeline" / "src" / "peoplelake"
    offenders = [
        str(p.relative_to(src))
        for p in src.rglob("*.py")
        if "bigquery.Client(" in p.read_text() and p.name != "bigquery_wh.py"
    ]
    assert offenders == []
    assert (src / "warehouse" / "bigquery_wh.py").read_text().count("bigquery.Client(") == 1


def test_dbt_bigquery_profiles_cap_every_query_at_1_gb():
    profiles = yaml.safe_load((repo_root() / "warehouse" / "profiles.yml").read_text())["peoplelake"]["outputs"]
    for target in ("prod", "prod-drill"):
        assert 0 < profiles[target]["maximum_bytes_billed"] <= 1_000_000_000, target
    project = yaml.safe_load((repo_root() / "warehouse" / "dbt_project.yml").read_text())
    assert project["query-comment"]["job-label"] is True
    assert project["models"]["peoplelake"]["+labels"] == {"app": "peoplelake"}


def test_python_budget_constants_match_the_worker():
    ts = (repo_root() / "src" / "shared" / "free-budget.ts").read_text()

    def number(name: str) -> int:
        m = re.search(rf"{name}\s*[:=]\s*([\d_]+)", ts)
        assert m, name
        return int(m.group(1).replace("_", ""))

    assert number("BQ_MONTHLY_BYTES_CAP") == BQ_MONTHLY_BYTES_CAP
    assert number("BQ_TRANSFORM_RESERVE_BYTES") == BQ_TRANSFORM_RESERVE_BYTES


def test_no_pl_dataset_or_identity_names_remain():
    """The shared project needs this repo's prefix everywhere (SPEC risk 31: the rename's blast radius)."""
    tracked = subprocess.run(["git", "ls-files"], cwd=repo_root(), capture_output=True, text=True).stdout.split()
    pattern = re.compile(
        r"\bpl_(raw|staging|core|restricted|reporting|ops)(_[a-z]+)?\b|\bpl_mask_|\bpl-(runner|analyst|dispatcher)@"
    )
    roots = ("pipeline/src/", "pipeline/tests/", "warehouse/", "src/", "scripts/", "test/", "infra/")
    offenders = [
        f
        for f in tracked
        if f.startswith(roots)
        and f != "pipeline/tests/test_bq_caps.py"
        and pattern.search((repo_root() / f).read_text(errors="ignore"))
    ]
    assert offenders == []
