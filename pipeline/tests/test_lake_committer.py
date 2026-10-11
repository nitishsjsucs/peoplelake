import json

import pytest

from peoplelake.lake.catalog import ensure_local_table, local_catalog
from peoplelake.lake.committer import PROP_RECOMMIT, DirectorySinkSource, commit_pending, committed_files
from peoplelake.lake.reader import read_appends
from peoplelake.warehouse.direct import canonical_order, direct_table, envelopes_from_dataset


@pytest.fixture(scope="module")
def records(small):
    table = direct_table(canonical_order(envelopes_from_dataset(small))[:30])
    rows = table.to_pylist()
    for r in rows:
        for c in ("source_updated_at", "received_at"):
            r[c] = r[c].strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return rows


def write_roll(root, seq, rows):
    path = root / "local-sink" / "raw_events" / f"{seq:08d}.ndjson"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


@pytest.fixture
def lake(tmp_path):
    return ensure_local_table(local_catalog(tmp_path / "lake"))


def test_commit_is_idempotent_on_key_and_etag(tmp_path, lake, records):
    sink = tmp_path / "sink"
    write_roll(sink, 1, records[:10])
    write_roll(sink, 2, records[10:20])
    source = DirectorySinkSource(sink)
    first = commit_pending(source, lake)
    assert (first.files_committed, first.rows_committed) == (2, 20)
    second = commit_pending(source, lake)
    assert (second.files_listed, second.files_committed) == (2, 0)
    assert [k for k, _ in committed_files(lake)] == [
        "local-sink/raw_events/00000001.ndjson",
        "local-sink/raw_events/00000002.ndjson",
    ]
    snap = lake.current_snapshot()
    assert snap.summary.additional_properties["peoplelake.stand-in"] == "local-committer"


def test_rewritten_roll_file_is_committed_again(tmp_path, lake, records):
    sink = tmp_path / "sink"
    write_roll(sink, 1, records[:10])
    source = DirectorySinkSource(sink)
    commit_pending(source, lake)
    write_roll(sink, 1, records[:15])  # crash between put and delete: same key, superset, new etag
    report = commit_pending(source, lake)
    assert (report.files_committed, report.rows_committed) == (1, 15)
    batch = read_appends(lake, None)
    assert batch.table.num_rows == 25  # duplicates stay in the lake; the loader dedupes on delivery_id


def test_recommit_reappends_latest_files_as_new_snapshots(tmp_path, lake, records):
    sink = tmp_path / "sink"
    for i in range(3):
        write_roll(sink, i + 1, records[i * 10 : (i + 1) * 10])
    source = DirectorySinkSource(sink)
    commit_pending(source, lake)
    before = lake.current_snapshot().snapshot_id
    report = commit_pending(source, lake, recommit=2)
    assert (report.files_committed, report.files_recommitted, report.rows_committed) == (0, 2, 20)
    recommits = [s for s in lake.snapshots() if s.summary.additional_properties.get(PROP_RECOMMIT) == "true"]
    assert len(recommits) == 2
    batch = read_appends(lake, before)
    assert batch.table.num_rows == 20
    assert set(batch.table.column("delivery_id").to_pylist()) == {r["delivery_id"] for r in records[10:30]}
    assert len(committed_files(lake)) == 3  # recommits are not new files
