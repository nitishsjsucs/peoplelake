"""BigQuery loader against a fake client: job configs, SQL shape (parsed as BigQuery) and call order."""

import io
from types import SimpleNamespace

import pyarrow.parquet as pq
import pytest
import sqlglot
from sqlglot import exp

from peoplelake.warehouse.bigquery_wh import BigQueryWarehouse, stage_name
from peoplelake.warehouse.direct import canonical_order, direct_table, envelopes_from_dataset


class FakeJob:
    def __init__(self, rows=None, affected=None):
        self.rows = rows or []
        self.num_dml_affected_rows = affected

    def result(self):
        return self.rows


class FakeClient:
    def __init__(self, *, fail_merge=False):
        self.calls = []
        self.fail_merge = fail_merge
        self.parquet = None

    def query(self, sql, job_config=None, location=None):
        params = {p.name: (p.type_, p.value) for p in (job_config.query_parameters if job_config else [])}
        self.calls.append(("query", sql, params, location))
        text = sql.strip().upper()
        if text.startswith("WITH BATCH"):
            return FakeJob(
                [
                    {
                        "rows_new": 3,
                        "unique_new_events": 2,
                        "min_effective_date_new": "2012-01-10",
                        "histogram": [{"bucket": 1790812800, "n": 2}],
                    }
                ]
            )
        if text.startswith("MERGE"):
            if self.fail_merge:
                raise RuntimeError("merge failed")
            return FakeJob(affected=3)
        if text.startswith("SELECT MAX"):
            return FakeJob([{"m": 42}])
        return FakeJob()

    def load_table_from_file(self, file, destination, job_config=None, location=None):
        self.parquet = pq.read_table(io.BytesIO(file.read()))
        self.calls.append(("load", destination, job_config, location))
        return FakeJob()

    def get_table(self, name):
        return SimpleNamespace(name=name, expires=None)

    def update_table(self, table, fields):
        self.calls.append(("update_table", table.name, fields, table.expires))

    def delete_table(self, name, not_found_ok=False):
        self.calls.append(("delete_table", name, not_found_ok))


@pytest.fixture(scope="module")
def batch(small):
    return direct_table(canonical_order(envelopes_from_dataset(small))[:3])


def test_ensure_raw_ddl_is_partitioned_and_clustered():
    client = FakeClient()
    BigQueryWarehouse(client, "proj").ensure_raw()
    ddl = client.calls[0][1]
    assert "PARTITION BY DATE(_pl_loaded_at)" in ddl
    assert "CLUSTER BY source, event_type, event_id" in ddl
    for _, sql, _, _ in client.calls:
        sqlglot.parse_one(sql, read="bigquery")


def test_load_job_merge_and_log(batch):
    client = FakeClient()
    wh = BigQueryWarehouse(client, "proj", location="US")
    stats = wh.load_deliveries(
        batch, run_id="r-x-000001", job_id="r-x-000001-load-a1", load_seq=42, snapshot_ids=["7"] * 3
    )

    load = next(c for c in client.calls if c[0] == "load")
    assert load[1] == "proj.pl_raw._stage_r_x_000001_load_a1"
    assert load[2].source_format == "PARQUET"
    assert load[2].write_disposition == "WRITE_TRUNCATE"
    assert client.parquet.column_names[-2:] == ["_pl_snapshot_id", "_ord"]
    assert client.parquet.num_rows == 3

    update = next(c for c in client.calls if c[0] == "update_table")
    assert update[2] == ["expires"] and update[3] is not None

    queries = [c for c in client.calls if c[0] == "query"]
    stats_sql, merge_sql, log_sql, max_sql = (q[1] for q in queries)
    merge = sqlglot.parse_one(merge_sql, read="bigquery")
    assert isinstance(merge, exp.Merge)
    assert "ON T.delivery_id = S.delivery_id" in merge_sql
    assert "WHEN NOT MATCHED THEN" in merge_sql
    assert "ORDER BY _ord ASC NULLS LAST" in merge_sql
    assert queries[1][2] == {
        "run_id": ("STRING", "r-x-000001"),
        "job_id": ("STRING", "r-x-000001-load-a1"),
        "load_seq": ("INT64", 42),
    }
    for sql in (stats_sql, log_sql, max_sql):
        sqlglot.parse_one(sql, read="bigquery")
    assert queries[2][2]["rows_inserted"] == ("INT64", 3)
    assert client.calls[-1] == ("delete_table", "proj.pl_raw._stage_r_x_000001_load_a1", True)

    assert stats.rows_inserted == 3 and stats.duplicate_deliveries_skipped == 0
    assert stats.unique_new_events == 2
    assert stats.raw_max_load_seq == 42
    assert stats.received_histogram_10s == [(1790812800, 2)]


def test_stage_is_dropped_when_merge_fails(batch):
    client = FakeClient(fail_merge=True)
    with pytest.raises(RuntimeError):
        BigQueryWarehouse(client, "proj").load_deliveries(batch, run_id="r", job_id="j", load_seq=1)
    assert client.calls[-1][0] == "delete_table"


def test_drill_suffix_targets_drill_datasets(batch):
    client = FakeClient()
    wh = BigQueryWarehouse(client, "proj", suffix="drill")
    wh.load_deliveries(batch, run_id="r", job_id="j", load_seq=1)
    assert wh.raw == "proj.pl_raw_drill.raw_event_deliveries"
    assert all("pl_raw_drill" in c[1] or "pl_ops_drill" in c[1] for c in client.calls if c[0] == "query")


def test_stage_name_is_a_valid_table_id():
    assert stage_name("r-mgk3x2-000042-load-a2") == "_stage_r_mgk3x2_000042_load_a2"
