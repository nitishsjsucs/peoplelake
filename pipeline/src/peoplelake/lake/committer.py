"""Landing commits (SPEC 29.4.1, ADR 0009): the runner's load job appends new landing rolls to the Iceberg
table, locally (pyiceberg SqlCatalog stand-in) and in production (Basin Catalog through RestCatalog).

The LandingRoller writes immutable NDJSON rolls `landing/raw_events/g<generation>/r<roll_seq>.ndjson`; a
retried roll rewrites identical bytes under the same key. Each new roll becomes one append snapshot whose
summary carries `peoplelake.landing-key`, `peoplelake.landing-etag` and the cursor
`peoplelake.landing-through` (that key), so a roll's rows and the cursor that covers them become visible in
one optimistic commit. The cursor is read from the newest snapshot of the current ancestry that carries it:
snapshot expiration (on in Basin Catalog, free) removes old snapshots but never the newest append, so it
can never make the committer append old rolls again. Even a double append would change nothing in the
warehouse, which merges on delivery_id (ADR 0001).

Every line is validated with the pydantic RawRecord before anything is appended; the Worker validated it
with the same contract, so a failure means a bug and fails the job loudly. On a commit conflict the
committer refreshes the table, re-reads the cursor and continues. The eval fault `recommit_sink_files`
re-appends the last `count` rolls at or below the cursor tagged `peoplelake.recommit=true`, without a
cursor property, so the cursor does not move.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, Protocol

from pydantic import ValidationError
from pyiceberg.exceptions import CommitFailedException
from pyiceberg.table import Table

from ..contracts import RawRecord
from ..normalize import records_to_arrow
from .catalog import disable_library_commit_retries

LANDING_PREFIX = "landing/raw_events/"
PROP_KEY = "peoplelake.landing-key"
PROP_ETAG = "peoplelake.landing-etag"
PROP_THROUGH = "peoplelake.landing-through"
PROP_COMMITTER = "peoplelake.committer"
PROP_RECOMMIT = "peoplelake.recommit"
MAX_CONFLICTS = 10


class LandingRoll(NamedTuple):
    key: str
    etag: str
    size: int


class LandingSource(Protocol):
    def list_rolls(self, prefix: str, after: str | None) -> list[LandingRoll]: ...

    def get(self, key: str) -> bytes: ...


class LandingError(RuntimeError):
    """A landing roll the committer refuses (a line that is not a valid RawRecord)."""


class DirectoryLandingSource:
    """Roll files under a local directory, keyed by their relative path (tests and offline tooling)."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def list_rolls(self, prefix: str, after: str | None) -> list[LandingRoll]:
        out = []
        for path in sorted(self.root.rglob("*.ndjson")):
            key = path.relative_to(self.root).as_posix()
            if not key.startswith(prefix) or (after is not None and key <= after):
                continue
            data = path.read_bytes()
            out.append(LandingRoll(key, hashlib.md5(data).hexdigest(), len(data)))
        return sorted(out, key=lambda r: r.key)

    def get(self, key: str) -> bytes:
        return (self.root / key).read_bytes()


@dataclass
class CommitReport:
    prefix: str = LANDING_PREFIX
    cursor_before: str | None = None
    cursor_after: str | None = None
    rolls_listed: int = 0
    rolls_committed: int = 0
    rolls_recommitted: int = 0
    rows_committed: int = 0
    conflicts: int = 0
    snapshots: list[str] = field(default_factory=list)


def landing_cursor(table: Table, snapshot_id: int | None = None) -> str | None:
    """`peoplelake.landing-through` of the newest snapshot in the ancestry of `snapshot_id` (default: the
    current snapshot) that carries it; None for a new table."""
    meta = table.metadata
    snap = meta.snapshot_by_id(snapshot_id) if snapshot_id is not None else table.current_snapshot()
    while snap is not None:
        props = snap.summary.additional_properties if snap.summary else {}
        if PROP_THROUGH in props:
            return props[PROP_THROUGH]
        snap = meta.snapshot_by_id(snap.parent_snapshot_id) if snap.parent_snapshot_id is not None else None
    return None


def parse_roll(key: str, data: bytes) -> list[dict]:
    """NDJSON lines of one roll, each validated as a RawRecord."""
    rows = []
    for number, line in enumerate(data.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
            RawRecord.model_validate(obj)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise LandingError(f"{key} line {number} is not a valid RawRecord: {str(exc).splitlines()[0]}") from exc
        rows.append(obj)
    return rows


def _snapshot_id(table: Table) -> str:
    snap = table.current_snapshot()
    return str(snap.snapshot_id) if snap else ""


def commit_pending(
    source: LandingSource, table: Table, *, prefix: str = LANDING_PREFIX, recommit: int = 0
) -> tuple[Table, CommitReport]:
    """Append every roll under `prefix` after the landing cursor, one snapshot per roll, in key order."""
    if not prefix.startswith(LANDING_PREFIX):
        raise LandingError(f"landing prefix {prefix!r} is outside {LANDING_PREFIX}")
    report = CommitReport(prefix=prefix)
    disable_library_commit_retries(table)
    cursor = landing_cursor(table)
    report.cursor_before = cursor
    rolls = sorted(source.list_rolls(prefix, cursor), key=lambda r: r.key)
    report.rolls_listed = len(rolls)
    for roll in rolls:
        if cursor is not None and roll.key <= cursor:
            continue
        arrow = records_to_arrow(parse_roll(roll.key, source.get(roll.key)))
        props = {PROP_KEY: roll.key, PROP_ETAG: roll.etag, PROP_THROUGH: roll.key, PROP_COMMITTER: "runner"}
        conflicts = 0
        while True:
            try:
                table.append(arrow, snapshot_properties=props)
            except CommitFailedException:
                # Someone else committed first: refresh, re-read the cursor, skip what is already covered.
                conflicts += 1
                report.conflicts += 1
                if conflicts > MAX_CONFLICTS:
                    raise
                table.refresh()
                cursor = landing_cursor(table)
                if cursor is not None and roll.key <= cursor:
                    break
                continue
            cursor = roll.key
            report.rolls_committed += 1
            report.rows_committed += arrow.num_rows
            report.snapshots.append(_snapshot_id(table))
            break
    if recommit > 0:
        cursor = landing_cursor(table)
        done = [r for r in sorted(source.list_rolls(prefix, None), key=lambda r: r.key) if cursor and r.key <= cursor]
        for roll in done[-recommit:]:
            arrow = records_to_arrow(parse_roll(roll.key, source.get(roll.key)))
            table.append(
                arrow,
                snapshot_properties={
                    PROP_KEY: roll.key,
                    PROP_ETAG: roll.etag,
                    PROP_RECOMMIT: "true",
                    PROP_COMMITTER: "runner",
                },
            )
            report.rolls_recommitted += 1
            report.rows_committed += arrow.num_rows
            report.snapshots.append(_snapshot_id(table))
    report.cursor_after = landing_cursor(table)
    return table, report
