"""Talent source: compensation changes and performance reviews."""

from __future__ import annotations

from collections.abc import Callable

from ..prng import SplitMix64
from .records import SourceRecord, epoch_seconds, iso_ts, lagged, office_second
from .world import World, iso

SOURCE = "talent"


def talent_records(world: World, rng: SplitMix64, next_order: Callable[[], int]) -> list[SourceRecord]:
    out: list[SourceRecord] = []

    def emit(event_type: str, subject: str, day: int, recorded_day: int, payload: dict) -> None:
        out.append(
            SourceRecord(
                source=SOURCE,
                event_type=event_type,
                entity_id=subject,
                recorded_ts=epoch_seconds(recorded_day, office_second(rng)),
                effective=day,
                payload=payload,
                order=next_order(),
            )
        )

    for ev in world.comp_events:
        recorded = ev.date - rng.randint(5, 20) if ev.reason == "merit" else lagged(rng, ev.date, 2)
        emit(
            "compensation.changed",
            ev.employee_id,
            ev.date,
            recorded,
            {
                "change_id": ev.change_id,
                "reason": ev.reason,
                "base_salary": ev.base_salary,
                "currency": "USD",
                "bonus_target_bp": ev.bonus_target_bp,
            },
        )
    for rv in world.reviews:
        emit(
            "review.submitted",
            rv.employee_id,
            rv.date,
            lagged(rng, rv.date, 10),
            {"review_id": rv.review_id, "cycle": rv.cycle, "rating": rv.rating, "reviewer_id": rv.reviewer_id},
        )
    return out


def envelope(rec: SourceRecord) -> dict:
    return {
        "uuid": rec.event_id,
        "kind": rec.event_type,
        "subject": rec.entity_id,
        "revision": rec.sequence,
        "updated": iso_ts(rec.recorded_ts),
        "asOf": iso(rec.effective),
        "version": 1,
        "body": rec.payload,
    }
