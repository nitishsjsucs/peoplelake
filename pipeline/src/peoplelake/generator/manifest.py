"""Dataset manifest: per-source and per-type counts plus sha256 digests."""

from __future__ import annotations

import hashlib
from collections import Counter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .dataset import Dataset


def build_manifest(ds: Dataset) -> dict:
    from .dataset import SOURCES
    from .world import SEED, WINDOW_END, iso

    sources = {}
    for source in SOURCES:
        counts = Counter(r.event_type for r in ds.records[source])
        sources[source] = {
            "count": len(ds.records[source]),
            "event_types": dict(sorted(counts.items())),
            "sha256": hashlib.sha256(ds.file_bytes(source)).hexdigest(),
        }
    return {
        "profile": ds.profile.name,
        "seed": SEED,
        "data_as_of": iso(WINDOW_END),
        "total_events": sum(v["count"] for v in sources.values()),
        "sources": sources,
        "dataset_sha256": ds.dataset_sha256(),
    }


def expected_event_counts_rows(ds: Dataset) -> list[tuple[str, str, str, int]]:
    """(profile, source, event_type, count) rows for warehouse/seeds/oracle/expected_event_counts.csv."""
    rows = []
    for source, types in ds.profile.expected_counts().items():
        for event_type, n in sorted(types.items()):
            rows.append((ds.profile.name, source, event_type, n))
    return rows
