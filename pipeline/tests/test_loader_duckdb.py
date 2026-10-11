import pyarrow as pa
import pytest

from peoplelake.warehouse.direct import canonical_order, direct_table, envelopes_from_dataset, load_direct, part
from peoplelake.warehouse.duckdb_wh import DuckDBWarehouse


@pytest.fixture
def wh(tmp_path):
    return DuckDBWarehouse(tmp_path / "wh.duckdb")


@pytest.fixture(scope="module")
def items(small):
    return canonical_order(envelopes_from_dataset(small))


def count(wh, sql="SELECT count(*) AS n FROM peoplelake_raw.raw_event_deliveries"):
    return wh.query_arrow(sql).column(0)[0].as_py()


def test_same_batch_twice_is_idempotent(wh, items):
    first = load_direct(wh, items[:1000], load_seq=1)
    assert (first.rows_read, first.rows_inserted, first.duplicate_deliveries_skipped) == (1000, 1000, 0)
    assert first.unique_new_events == 1000
    second = load_direct(wh, items[:1000], load_seq=2)
    assert (second.rows_inserted, second.duplicate_deliveries_skipped, second.unique_new_events) == (0, 1000, 0)
    assert count(wh) == 1000
    assert second.raw_max_load_seq == 1  # nothing was stamped with the second sequence
    assert second.received_histogram_10s == []


def test_full_small_profile_loads_10000_unique_events(wh, items):
    stats = load_direct(wh, items)
    assert stats.rows_inserted == 10_000
    assert count(wh, "SELECT count(DISTINCT event_id) FROM peoplelake_raw.raw_event_deliveries") == 10_000
    assert count(wh, "SELECT count(*) FROM peoplelake_ops.load_log") == 1


def test_parts_cover_everything_once(items):
    pieces = [part(items, i, 3) for i in (1, 2, 3)]
    assert sum(len(p) for p in pieces) == len(items)
    assert [x for p in pieces for x in p] == items


def test_within_batch_duplicate_deliveries_are_deduplicated(wh, items):
    table = direct_table(items[:10])
    doubled = pa.concat_tables([table, table])
    wh.ensure_raw()
    stats = wh.load_deliveries(doubled, run_id="r", job_id="j", load_seq=5, snapshot_ids=["s1"] * 10 + ["s2"] * 10)
    assert (stats.rows_read, stats.rows_inserted, stats.duplicate_deliveries_skipped) == (20, 10, 10)
    snaps = (
        wh.query_arrow("SELECT DISTINCT _pl_snapshot_id AS s FROM peoplelake_raw.raw_event_deliveries")
        .column("s")
        .to_pylist()
    )
    assert snaps == ["s1"]  # first occurrence wins


def test_new_delivery_of_known_event_is_inserted_but_not_a_new_event(wh, items):
    load_direct(wh, items[:5], load_seq=1)
    table = direct_table(items[:5])
    redelivered = table.set_column(
        table.column_names.index("delivery_id"),
        "delivery_id",
        pa.array([f"00000000-0000-4000-8000-00000000000{i}" for i in range(5)]),
    )
    stats = wh.load_deliveries(redelivered, run_id="r", job_id="j", load_seq=2)
    assert stats.rows_inserted == 5
    assert stats.unique_new_events == 0
    assert stats.received_histogram_10s == []
    assert stats.raw_max_load_seq == 2


def test_stats_histogram_and_min_effective_date(wh, items):
    stats = load_direct(wh, items[:50], load_seq=7)
    assert stats.received_histogram_10s == [(1790812800, 50)]  # 2026-10-01T00:00:00Z
    assert stats.min_effective_date_new == min(r for r in direct_table(items[:50]).column("effective_date").to_pylist())
    assert stats.raw_max_load_seq == 7


def test_a_retried_load_attempt_reports_the_same_events_as_the_attempt_that_merged(wh, items):
    """SPEC 2.2 and fault S4: attempt 1 merges and never delivers its result; attempt 2 of the same run (same
    load_seq) must report the same new events, or the freshness ledger loses them for good."""
    table = direct_table(items[:500])
    wh.ensure_raw()
    first = wh.load_deliveries(table, run_id="r", job_id="r-load-a1", load_seq=7)
    second = wh.load_deliveries(table, run_id="r", job_id="r-load-a2", load_seq=7)
    assert (first.rows_inserted, second.rows_inserted) == (500, 0)
    assert first.unique_new_events == second.unique_new_events == 500
    assert first.received_histogram_10s == second.received_histogram_10s != []
    assert first.min_effective_date_new == second.min_effective_date_new
    # A later attempt that also reads newer rolls reports both the merged and the new events.
    third = wh.load_deliveries(direct_table(items[:600]), run_id="r", job_id="r-load-a3", load_seq=7)
    assert (third.rows_inserted, third.unique_new_events) == (100, 600)
    # The next run's load reports only what it brought in first.
    nxt = wh.load_deliveries(direct_table(items[:650]), run_id="r2", job_id="r2-load-a1", load_seq=8)
    assert (nxt.rows_inserted, nxt.unique_new_events) == (50, 50)


def test_reset_removes_the_file(wh, items):
    load_direct(wh, items[:3])
    wh.reset()
    assert not wh.path.exists()
