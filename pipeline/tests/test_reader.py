import pyarrow as pa
import pytest

from peoplelake.lake.catalog import ensure_local_table, local_catalog
from peoplelake.lake.reader import read_appends
from peoplelake.lake.schema import RAW_ARROW_SCHEMA
from peoplelake.warehouse.direct import canonical_order, direct_table, envelopes_from_dataset


@pytest.fixture(scope="module")
def rows(small):
    return direct_table(canonical_order(envelopes_from_dataset(small))[:40])


@pytest.fixture
def table(tmp_path):
    return ensure_local_table(local_catalog(tmp_path / "lake"))


def append(table, rows, start, end):
    table.append(rows.slice(start, end - start))
    return table.current_snapshot().snapshot_id


def test_empty_table_reads_nothing(table):
    batch = read_appends(table, None)
    assert batch.table.num_rows == 0 and batch.info.to_snapshot is None


def test_incremental_reads_between_snapshots(table, rows):
    s1 = append(table, rows, 0, 10)
    s2 = append(table, rows, 10, 25)
    s3 = append(table, rows, 25, 40)
    batch = read_appends(table, s1)
    assert batch.table.num_rows == 30
    assert batch.info.snapshots_read == 2 and not batch.info.fallback_full_scan
    assert batch.snapshot_ids == [str(s2)] * 15 + [str(s3)] * 15
    assert batch.table.column("delivery_id").to_pylist() == rows.column("delivery_id").to_pylist()[10:]
    upto = read_appends(table, s1, s2)
    assert upto.table.num_rows == 15 and upto.info.to_snapshot == str(s2)
    assert read_appends(table, s3).table.num_rows == 0


def test_replay_reads_everything_as_of_a_snapshot(table, rows):
    append(table, rows, 0, 10)
    s2 = append(table, rows, 10, 25)
    append(table, rows, 25, 40)
    batch = read_appends(table, None, s2)
    assert batch.table.num_rows == 25
    assert not batch.info.fallback_full_scan  # planned full read, not a fallback
    assert batch.table.schema == RAW_ARROW_SCHEMA


def test_missing_from_snapshot_falls_back_to_full_scan(table, rows):
    append(table, rows, 0, 10)
    append(table, rows, 10, 40)
    batch = read_appends(table, 123456789)  # expired or unknown snapshot
    assert batch.info.fallback_full_scan
    assert batch.table.num_rows == 40


def test_non_append_snapshots_are_skipped(table, rows):
    s1 = append(table, rows, 0, 10)
    first_delivery = rows.column("delivery_id")[0].as_py()
    table.delete(f"delivery_id = '{first_delivery}'")  # a rewrite, like compaction: not an append
    assert table.current_snapshot().summary.operation.value != "append"
    s3 = append(table, rows, 10, 20)
    assert len(table.snapshots()) >= 3
    batch = read_appends(table, s1)
    assert batch.table.num_rows == 10
    assert set(batch.snapshot_ids) == {str(s3)}


def test_reader_casts_naive_timestamps_to_utc():
    from peoplelake.lake.schema import to_canonical

    naive = pa.table(
        {
            name: (
                pa.array([None], pa.timestamp("ms")).fill_null(0)
                if name in ("source_updated_at", "received_at")
                else pa.array([1 if name in ("source_sequence", "schema_version") else "x"])
            )
            for name in RAW_ARROW_SCHEMA.names
        }
    )
    assert to_canonical(naive).schema == RAW_ARROW_SCHEMA
