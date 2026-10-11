"""Local stand-in for the Basin sink's Iceberg commits (SPEC 9.3). Never runs in production.

The SinkRoller Durable Object writes NDJSON roll files to local R2; this committer appends each new
`(key, etag)` file as one Iceberg snapshot tagged with `peoplelake.source-file` and
`peoplelake.source-etag`. A file rewritten after a crash (same key, superset, new etag) is committed
again; the loader deduplicates deliveries by delivery_id. `recommit > 0` (eval fault
`recommit_sink_files`) re-appends that many already committed files as new snapshots.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, Protocol

from pyiceberg.table import Table

from ..normalize import records_to_arrow

PROP_FILE = "peoplelake.source-file"
PROP_ETAG = "peoplelake.source-etag"
PROP_RECOMMIT = "peoplelake.recommit"
PROP_STAND_IN = "peoplelake.stand-in"


class SinkFile(NamedTuple):
    key: str
    etag: str
    size: int


class SinkSource(Protocol):
    def list_files(self) -> list[SinkFile]: ...

    def get(self, key: str) -> bytes: ...


class DirectorySinkSource:
    """Roll files in a local directory (tests and offline tooling); the etag is the content md5."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def list_files(self) -> list[SinkFile]:
        out = []
        for path in sorted(self.root.rglob("*.ndjson")):
            data = path.read_bytes()
            out.append(SinkFile(str(path.relative_to(self.root)), hashlib.md5(data).hexdigest(), len(data)))
        return out

    def get(self, key: str) -> bytes:
        return (self.root / key).read_bytes()


@dataclass
class CommitReport:
    files_listed: int = 0
    files_committed: int = 0
    files_recommitted: int = 0
    rows_committed: int = 0
    snapshots: list[str] = field(default_factory=list)


def committed_files(table: Table) -> list[tuple[str, str]]:
    """(key, etag) of committed sink files in commit order (recommits excluded)."""
    out = []
    for snap in sorted(table.snapshots(), key=lambda s: s.sequence_number):
        props = snap.summary.additional_properties if snap.summary else {}
        if PROP_FILE in props and props.get(PROP_RECOMMIT) != "true":
            out.append((props[PROP_FILE], props.get(PROP_ETAG, "")))
    return out


def _append(table: Table, data: bytes, props: dict[str, str]) -> tuple[str, int]:
    records = [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
    arrow = records_to_arrow(records)
    table.append(arrow, snapshot_properties=props)
    snap = table.current_snapshot()
    return (str(snap.snapshot_id) if snap else ""), arrow.num_rows


def commit_pending(source: SinkSource, table: Table, *, recommit: int = 0) -> CommitReport:
    report = CommitReport()
    done = set(committed_files(table))
    files = source.list_files()
    report.files_listed = len(files)
    for f in sorted(files, key=lambda f: f.key):
        if (f.key, f.etag) in done:
            continue
        snap, rows = _append(
            table, source.get(f.key), {PROP_FILE: f.key, PROP_ETAG: f.etag, PROP_STAND_IN: "local-committer"}
        )
        report.files_committed += 1
        report.rows_committed += rows
        report.snapshots.append(snap)
        done.add((f.key, f.etag))
    if recommit > 0:
        latest = committed_files(table)[-recommit:]
        for key, etag in latest:
            snap, rows = _append(
                table,
                source.get(key),
                {PROP_FILE: key, PROP_ETAG: etag, PROP_RECOMMIT: "true", PROP_STAND_IN: "local-committer"},
            )
            report.files_recommitted += 1
            report.rows_committed += rows
            report.snapshots.append(snap)
    return report
