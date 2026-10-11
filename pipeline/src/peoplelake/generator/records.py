"""Source records before sequencing: one per emitted event, with an optional reference to the
record a correction or rescind targets (resolved to an event_id after sequencing)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from ..prng import SplitMix64
from .world import WINDOW_END

EPOCH_ORDINAL = date(1970, 1, 1).toordinal()


def epoch_seconds(ordinal: int, second_of_day: int) -> int:
    return (ordinal - EPOCH_ORDINAL) * 86400 + second_of_day


def iso_ts(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def office_second(rng: SplitMix64) -> int:
    """A time of day between 08:00:00 and 19:59:59 UTC."""
    return rng.randint(8 * 3600, 20 * 3600 - 1)


def lagged(rng: SplitMix64, day: int, max_lag: int) -> int:
    return min(day + rng.randint(0, max_lag), WINDOW_END)


@dataclass
class SourceRecord:
    source: str
    event_type: str
    entity_id: str
    recorded_ts: int
    effective: int
    payload: dict[str, Any]
    order: int
    target: SourceRecord | None = None
    target_field: str | None = None  # payload key that receives the target's event_id
    sequence: int = 0
    event_id: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def recorded_day(self) -> int:
        return self.recorded_ts // 86400 + EPOCH_ORDINAL
