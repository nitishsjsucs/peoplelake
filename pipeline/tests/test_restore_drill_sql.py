import pytest
import sqlglot
from sqlglot import exp

from peoplelake.prod.drills import BUCKETED, restore_sql
from peoplelake.warehouse.digest import MODEL_SPECS


@pytest.mark.parametrize("model", sorted(MODEL_SPECS))
def test_restore_sql_parses_as_bigquery_and_targets_drill(model):
    stmt = restore_sql("peoplelake-123", model, 1_800_000_000_000)
    tree = sqlglot.parse_one(stmt.sql, read="bigquery")
    assert isinstance(tree, exp.Create)
    assert stmt.target.split(".")[1].endswith("_drill")
    assert not stmt.source.split(".")[1].endswith("_drill")
    assert "FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(1800000000000)" in stmt.sql


@pytest.mark.parametrize("model", sorted(BUCKETED))
def test_bucketed_restores_keep_range_partition_and_clustering(model):
    stmt = restore_sql("peoplelake-123", model, 1)
    assert "PARTITION BY RANGE_BUCKET(employee_bucket, GENERATE_ARRAY(0, 2048, 1))" in stmt.sql
    assert "CLUSTER BY employee_id" in stmt.sql


def test_unbucketed_restores_have_no_partition():
    assert "PARTITION BY" not in restore_sql("p", "dim_job", 1).sql
