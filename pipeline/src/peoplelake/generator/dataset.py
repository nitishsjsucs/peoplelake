"""Assemble the three source files from the world: sequence numbers, event ids, canonical JSONL."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from itertools import count
from pathlib import Path

from ..canonical import canonical_json
from ..prng import SplitMix64
from . import ats, hris, talent
from .manifest import build_manifest
from .profiles import Profile
from .records import SourceRecord
from .world import SEED, World, build_world

NAMESPACE_PL = uuid.UUID("6f1d2c3b-8a47-4e59-9b10-7c2e5a4d3f81")
SOURCES: tuple[str, ...] = ("hris", "ats", "talent")
ENVELOPES = {"hris": hris.envelope, "ats": ats.envelope, "talent": talent.envelope}


def event_id(profile: str, source: str, sequence: int) -> str:
    return str(uuid.uuid5(NAMESPACE_PL, f"{profile}/{source}/{sequence}"))


@dataclass
class Dataset:
    profile: Profile
    world: World
    records: dict[str, list[SourceRecord]]
    lines: dict[str, list[str]]

    def file_bytes(self, source: str) -> bytes:
        return "".join(line + "\n" for line in self.lines[source]).encode("ascii")

    def dataset_sha256(self) -> str:
        h = hashlib.sha256()
        for source in SOURCES:
            h.update(self.file_bytes(source))
        return h.hexdigest()

    def manifest(self) -> dict:
        return build_manifest(self)

    def envelopes(self, source: str) -> list[dict]:
        env = ENVELOPES[source]
        return [env(r) for r in self.records[source]]

    def write(self, out: Path) -> dict:
        out.mkdir(parents=True, exist_ok=True)
        for source in SOURCES:
            (out / f"{source}.jsonl").write_bytes(self.file_bytes(source))
        manifest = self.manifest()
        (out / "manifest.json").write_text(canonical_json(manifest) + "\n", encoding="ascii")
        return manifest


def generate(profile: Profile) -> Dataset:
    world = build_world(profile)
    root = SplitMix64(SEED).fork(f"records:{profile.name}")
    order = count(1)

    def next_order() -> int:
        return next(order)

    records = {
        "hris": hris.hris_records(world, root.fork("hris"), next_order),
        "ats": ats.ats_records(world, root.fork("ats"), next_order),
        "talent": talent.talent_records(world, root.fork("talent"), next_order),
    }
    for source, recs in records.items():
        recs.sort(key=lambda r: (r.recorded_ts, r.order))
        for i, r in enumerate(recs, start=1):
            r.sequence = i
            r.event_id = event_id(profile.name, source, i)
    for recs in records.values():
        for r in recs:
            if r.target is not None and r.target.sequence >= r.sequence:
                raise AssertionError("a correction or rescind must be sequenced after its target")
    lines = {source: [canonical_json(ENVELOPES[source](r)) for r in recs] for source, recs in records.items()}
    return Dataset(profile=profile, world=world, records=records, lines=lines)
