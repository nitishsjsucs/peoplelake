import json

import pytest

from peoplelake.lake.catalog import TABLE_ID, ensure_table, local_catalog
from peoplelake.lake.committer import (
    PROP_COMMITTER,
    PROP_KEY,
    PROP_RECOMMIT,
    PROP_THROUGH,
    DirectoryLandingSource,
    LandingError,
    commit_pending,
    landing_cursor,
)
from peoplelake.lake.reader import read_appends
from peoplelake.warehouse.direct import canonical_order, direct_table, envelopes_from_dataset

GEN = 1791700000
PREFIX = f"landing/raw_events/g{GEN}/"


@pytest.fixture(scope="module")
def records(small):
    table = direct_table(canonical_order(envelopes_from_dataset(small))[:40])
    rows = table.to_pylist()
    for r in rows:
        for c in ("source_updated_at", "received_at"):
            r[c] = r[c].strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return rows


def key(seq, gen=GEN):
    return f"landing/raw_events/g{gen}/r{seq:010d}.ndjson"


def write_roll(root, seq, rows, gen=GEN):
    path = root / key(seq, gen)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.fixture
def catalog(tmp_path):
    return local_catalog(tmp_path / "lake")


@pytest.fixture
def lake(catalog):
    return ensure_table(catalog)


def test_each_roll_is_one_append_carrying_the_cursor_and_a_second_pass_commits_nothing(tmp_path, lake, records):
    landing = tmp_path / "landing"
    write_roll(landing, 1, records[:10])
    write_roll(landing, 2, records[10:20])
    source = DirectoryLandingSource(landing)
    lake, first = commit_pending(source, lake, prefix=PREFIX)
    assert (first.rolls_committed, first.rows_committed, first.cursor_before, first.cursor_after) == (
        2,
        20,
        None,
        key(2),
    )
    props = [s.summary.additional_properties for s in sorted(lake.snapshots(), key=lambda s: s.sequence_number)]
    assert [(p[PROP_KEY], p[PROP_THROUGH], p[PROP_COMMITTER]) for p in props] == [
        (key(1), key(1), "runner"),
        (key(2), key(2), "runner"),
    ]
    lake, second = commit_pending(source, lake, prefix=PREFIX)
    assert (second.rolls_listed, second.rolls_committed) == (0, 0)  # listed after the cursor only
    write_roll(landing, 3, records[20:25])
    lake, third = commit_pending(source, lake, prefix=PREFIX)
    assert (third.rolls_committed, third.cursor_after) == (1, key(3))
    assert read_appends(lake, None).table.num_rows == 25


def test_the_cursor_survives_snapshot_expiration_and_nothing_is_appended_again(tmp_path, lake, records):
    landing = tmp_path / "landing"
    for i in range(4):
        write_roll(landing, i + 1, records[i * 10 : (i + 1) * 10])
    source = DirectoryLandingSource(landing)
    lake, _ = commit_pending(source, lake, prefix=PREFIX)
    snaps = sorted(lake.snapshots(), key=lambda s: s.sequence_number)
    # Basin Catalog's snapshot expiration (kept on, free) removes old snapshots; do the same with pyiceberg.
    lake.maintenance.expire_snapshots().by_ids([s.snapshot_id for s in snaps[:3]]).commit()
    lake.refresh()
    assert len(lake.snapshots()) == 1
    assert landing_cursor(lake) == key(4)
    lake, again = commit_pending(source, lake, prefix=PREFIX)
    assert (again.rolls_listed, again.rolls_committed) == (0, 0)
    assert lake.scan().to_arrow().num_rows == 40


def test_the_cursor_comes_from_the_newest_snapshot_that_carries_it(tmp_path, lake, records):
    landing = tmp_path / "landing"
    for i in range(3):
        write_roll(landing, i + 1, records[i * 10 : (i + 1) * 10])
    source = DirectoryLandingSource(landing)
    lake, _ = commit_pending(source, lake, prefix=PREFIX)
    before = lake.current_snapshot().snapshot_id
    lake, report = commit_pending(source, lake, prefix=PREFIX, recommit=2)  # eval fault recommit_sink_files
    assert (report.rolls_committed, report.rolls_recommitted, report.rows_committed) == (0, 2, 20)
    recommits = [s for s in lake.snapshots() if s.summary.additional_properties.get(PROP_RECOMMIT) == "true"]
    assert [s.summary.additional_properties[PROP_KEY] for s in recommits] == [key(2), key(3)]
    assert all(PROP_THROUGH not in s.summary.additional_properties for s in recommits)
    assert landing_cursor(lake) == key(3)  # the recommit snapshots on top leave the cursor where it was
    batch = read_appends(lake, before)
    assert batch.table.num_rows == 20
    assert set(batch.table.column("delivery_id").to_pylist()) == {r["delivery_id"] for r in records[10:30]}
    assert landing_cursor(lake, before) == key(3)


def test_a_commit_conflict_refreshes_rereads_the_cursor_and_continues(tmp_path, catalog, records):
    landing = tmp_path / "landing"
    write_roll(landing, 1, records[:10])
    write_roll(landing, 2, records[10:20])
    source = DirectoryLandingSource(landing)
    stale = ensure_table(catalog)
    fresh = catalog.load_table(TABLE_ID)
    _, first = commit_pending(DirectoryLandingSource(landing), fresh, prefix=PREFIX)
    assert first.rolls_committed == 2
    write_roll(landing, 3, records[20:30])
    table, report = commit_pending(source, stale, prefix=PREFIX)  # stale handle: its cursor is None
    assert report.conflicts == 1
    assert (report.rolls_committed, report.cursor_after) == (1, key(3))
    table.refresh()
    assert table.scan().to_arrow().num_rows == 30  # rolls 1 and 2 were not appended twice
    keys = [
        s.summary.additional_properties[PROP_THROUGH]
        for s in sorted(table.snapshots(), key=lambda s: s.sequence_number)
    ]
    assert keys == [key(1), key(2), key(3)]  # the cursor never moved backwards


def test_the_table_disables_pyiceberg_commit_retries(lake):
    # pyiceberg would otherwise re-apply a conflicting append by itself, without the committer's cursor check.
    assert lake.properties["commit.retry.num-retries"] == "0"


def test_only_the_current_generation_prefix_is_listed(tmp_path, lake, records):
    landing = tmp_path / "landing"
    write_roll(landing, 1, records[:10], gen=GEN - 100)  # a roll of an earlier generation (before a reset)
    write_roll(landing, 1, records[10:15])
    lake, report = commit_pending(DirectoryLandingSource(landing), lake, prefix=PREFIX)
    assert (report.rolls_listed, report.rolls_committed, report.rows_committed) == (1, 1, 5)
    with pytest.raises(LandingError, match="outside"):
        commit_pending(DirectoryLandingSource(landing), lake, prefix="reports/")


def test_a_line_that_is_not_a_raw_record_fails_loudly_and_commits_nothing_after_it(tmp_path, lake, records):
    landing = tmp_path / "landing"
    write_roll(landing, 1, records[:5])
    bad = dict(records[5])
    del bad["payload_sha256"]
    write_roll(landing, 2, [records[6], bad])
    with pytest.raises(LandingError, match=r"r0000000002\.ndjson line 2"):
        commit_pending(DirectoryLandingSource(landing), lake, prefix=PREFIX)
    lake.refresh()
    assert landing_cursor(lake) == key(1)  # roll 1 is committed with its cursor; roll 2 is not
    assert lake.scan().to_arrow().num_rows == 5
