"""BigQuery-only dbt configs as the offline BigQuery target parses them (SPEC 11.7, 11.9)."""

import pytest

from peoplelake.devtools.bq_offline import compile_branch, manifest

pytestmark = pytest.mark.dbt


@pytest.fixture(scope="module")
def nodes(tmp_path_factory):
    m = manifest(tmp_path_factory.mktemp("bq-manifest"))
    return {n["name"]: n for n in m["nodes"].values() if n["resource_type"] == "model"}


def test_restricted_columns_carry_policy_tags_with_persist_docs(nodes):
    comp = nodes["fct_compensation_history"]
    assert comp["config"]["persist_docs"]["columns"] is True
    for col in ("base_salary", "bonus_target_pct"):
        tags = comp["columns"][col]["policy_tags"]
        assert len(tags) == 1 and "policyTags/compensation" in tags[0]
    reviews = nodes["fct_performance_reviews"]
    assert "policyTags/performance" in reviews["columns"]["rating"]["policy_tags"][0]
    assert reviews["config"]["persist_docs"]["columns"] is True


def test_reporting_views_are_authorized_on_core(nodes):
    rpt = [n for name, n in nodes.items() if name.startswith("rpt_")]
    assert len(rpt) == 3  # rpt_metrics_monthly (suppression) and the two views over it
    for n in rpt:
        assert n["config"]["materialized"] == "view"
        assert n["config"]["grant_access_to"] == [{"project": "peoplelake-offline", "dataset": "peoplelake_core"}]
        assert n["schema"] == "peoplelake_reporting"


def test_analyst_views_are_authorized_on_restricted_and_restricted_tables_are_never_recreated(nodes):
    for name in ("compensation_history", "performance_reviews"):
        n = nodes[name]
        assert n["schema"] == "peoplelake_restricted_access"
        assert n["config"]["materialized"] == "view"
        assert n["config"]["grant_access_to"] == [{"project": "peoplelake-offline", "dataset": "peoplelake_restricted"}]
    # A `create or replace` would leave the tagged columns untagged until persist_docs ran again.
    for name in ("fct_compensation_history", "fct_performance_reviews"):
        assert nodes[name]["config"]["materialized"] == "incremental"
        assert nodes[name]["config"]["full_refresh"] is False
    assert nodes["fct_performance_reviews"]["config"]["incremental_strategy"] == "merge"
    assert nodes["fct_performance_reviews"]["config"]["unique_key"] == "review_id"


def test_bucketed_models_use_int64_range_insert_overwrite(nodes):
    for name in ("dim_employee_history", "fct_workforce_monthly", "fct_compensation_history"):
        cfg = nodes[name]["config"]
        assert cfg["incremental_strategy"] == "insert_overwrite"
        assert cfg["partition_by"] == {
            "field": "employee_bucket",
            "data_type": "int64",
            "range": {"start": 0, "end": 2048, "interval": 1},
        }
        assert cfg["cluster_by"] == ["employee_id"]
        assert any("pl_bucket_pre_delete" in hook["sql"] for hook in cfg["pre-hook"])


def test_schemas_map_to_bigquery_datasets(nodes):
    assert nodes["stg_events"]["schema"] == "peoplelake_staging"
    assert nodes["metrics_workforce_monthly"]["schema"] == "peoplelake_core"
    assert nodes["fct_compensation_history"]["schema"] == "peoplelake_restricted"
    assert nodes["ops_anomalies"]["schema"] == "peoplelake_ops"


@pytest.mark.parametrize("branch", ["full-build", "incremental"])
def test_offline_compile_parses_as_bigquery_and_lints_clean(tmp_path, branch):
    report = compile_branch(branch, tmp_path / branch)
    assert report.compiled_models == 30
    assert report.compiled_tests > 80
    assert report.parse_errors == []
    assert report.order_violations == []
