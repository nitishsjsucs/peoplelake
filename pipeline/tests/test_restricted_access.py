"""Column security in production: analysts read the restricted tables only through views in their own
dataset, every restricted column must carry its policy tag after each build, and the runner fails the run
(dropping the analyst views) when one does not."""

from types import SimpleNamespace

import yaml
from google.api_core.exceptions import NotFound

from peoplelake.paths import repo_root
from peoplelake.runner.jobs import Faults, run_transform, seed_checksum
from peoplelake.warehouse.bigquery_wh import RESTRICTED_COLUMNS, BigQueryWarehouse, policy_tag_problems

TAGS = {"compensation": "pt/compensation", "performance": "pt/performance"}


def table(names_by_column):
    return SimpleNamespace(
        schema=[SimpleNamespace(name=c, policy_tags=SimpleNamespace(names=n)) for c, n in names_by_column.items()]
    )


def tagged(table_id):
    t = table_id.split(".")[-1]
    return table({c: [TAGS[tag]] for (tt, c), tag in RESTRICTED_COLUMNS.items() if tt == t})


def test_restricted_columns_need_their_tags():
    assert policy_tag_problems(tagged, "p.peoplelake_restricted", TAGS) == []

    def untagged_rating(table_id):
        if table_id.endswith("fct_performance_reviews"):
            return table({"rating": []})
        return tagged(table_id)

    assert policy_tag_problems(untagged_rating, "p.peoplelake_restricted", TAGS) == [
        "fct_performance_reviews.rating lacks the performance policy tag"
    ]

    def missing(table_id):
        raise NotFound(table_id)

    assert len(policy_tag_problems(missing, "p.peoplelake_restricted", TAGS)) == 3
    # Without the PL_PT_* settings nothing can match, so every column is reported.
    assert len(policy_tag_problems(tagged, "p.peoplelake_restricted", {})) == 3


def test_bigquery_warehouse_checks_the_live_tables_and_drops_the_analyst_views(monkeypatch):
    monkeypatch.setenv("PL_PT_COMPENSATION", TAGS["compensation"])
    monkeypatch.setenv("PL_PT_PERFORMANCE", TAGS["performance"])
    deleted = []
    client = SimpleNamespace(get_table=tagged, delete_table=lambda ref, not_found_ok=False: deleted.append(ref))
    wh = BigQueryWarehouse(client, "proj")
    assert wh.restricted_tag_problems() == []
    wh.close_restricted_access()
    assert deleted == [
        "proj.peoplelake_restricted_access.compensation_history",
        "proj.peoplelake_restricted_access.performance_reviews",
    ]


def test_a_build_that_leaves_a_column_untagged_fails_the_transform_and_closes_the_views():
    closed = []
    warehouse = SimpleNamespace(
        kind="bigquery",
        seed_checksum=seed_checksum,
        max_load_seq=lambda base, t: 1,
        restricted_tag_problems=lambda: ["fct_compensation_history.base_salary lacks the compensation policy tag"],
        close_restricted_access=lambda: closed.append(True),
    )
    dbt = SimpleNamespace(build=lambda **kw: SimpleNamespace(success=True))
    job = {"job_id": "j", "run_id": "r", "attempt": 1, "input": {"full_refresh": False}}
    result = run_transform(job, warehouse=warehouse, dbt=dbt, upload=None, profile="full", faults=Faults())
    assert result["status"] == "failed"
    assert "base_salary lacks the compensation policy tag" in result["error"] and closed == [True]


def test_the_analyst_views_expose_the_tagged_columns_and_nothing_internal():
    root = repo_root() / "warehouse" / "models" / "restricted_access"
    comp = (root / "compensation_history.sql").read_text()
    reviews = (root / "performance_reviews.sql").read_text()
    for (t, column), _ in RESTRICTED_COLUMNS.items():
        assert f".{column}" in (comp if t == "fct_compensation_history" else reviews)
    for sql in (comp, reviews):
        assert "_pl_load_seq" not in sql and "employee_bucket" not in sql
        assert "grant_access_to" in sql and "peoplelake_restricted" in sql
    project = yaml.safe_load((repo_root() / "warehouse" / "dbt_project.yml").read_text())
    assert project["models"]["peoplelake"]["restricted_access"]["+schema"] == "peoplelake_restricted_access"
