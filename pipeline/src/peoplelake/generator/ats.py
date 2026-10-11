"""ATS source: requisitions, applications, stage changes and offers."""

from __future__ import annotations

from collections.abc import Callable

from ..prng import SplitMix64
from .records import SourceRecord, epoch_seconds, iso_ts, office_second
from .world import World, iso

SOURCE = "ats"


def ats_records(world: World, rng: SplitMix64, next_order: Callable[[], int]) -> list[SourceRecord]:
    out: list[SourceRecord] = []

    def emit(event_type: str, kind: str, obj_id: str, day: int, payload: dict, ts: int | None = None) -> SourceRecord:
        rec = SourceRecord(
            source=SOURCE,
            event_type=event_type,
            entity_id=obj_id,
            recorded_ts=ts if ts is not None else epoch_seconds(day, office_second(rng)),
            effective=day,
            payload=payload,
            order=next_order(),
            meta={"kind": kind},
        )
        out.append(rec)
        return rec

    for req in world.requisitions:
        emit(
            "requisition.opened",
            "requisition",
            req.requisition_id,
            req.opened,
            {"requisition_id": req.requisition_id, "department_id": req.department_id, "job_code": req.job_code},
        )
    for app in world.applications:
        emit(
            "application.submitted",
            "application",
            app.application_id,
            app.submitted,
            {
                "application_id": app.application_id,
                "requisition_id": app.requisition.requisition_id,
                "candidate_id": app.candidate_id,
            },
        )
        for day, from_stage, to_stage in app.stages:
            emit(
                "application.stage_changed",
                "application",
                app.application_id,
                day,
                {"application_id": app.application_id, "from_stage": from_stage, "to_stage": to_stage},
            )
    decided: dict[str, int] = {}
    for offer in world.offers:
        emit(
            "offer.extended",
            "offer",
            offer.offer_id,
            offer.extended,
            {
                "offer_id": offer.offer_id,
                "application_id": offer.application_id,
                "requisition_id": offer.requisition.requisition_id,
                "candidate_id": offer.candidate_id,
                "proposed_start_date": iso(offer.proposed_start),
            },
        )
        if offer.status == "accepted":
            rec = emit(
                "offer.accepted",
                "offer",
                offer.offer_id,
                offer.decision,
                {"offer_id": offer.offer_id, "start_date": iso(offer.proposed_start)},
            )
            decided[offer.requisition.requisition_id] = rec.recorded_ts
        else:
            emit(f"offer.{offer.status}", "offer", offer.offer_id, offer.decision, {"offer_id": offer.offer_id})
    for req in world.requisitions:
        if req.closed is None:
            continue
        ts = None
        if req.requisition_id in decided:
            ts = min(decided[req.requisition_id] + rng.randint(60, 3600), epoch_seconds(req.closed, 86399))
        emit(
            "requisition.closed",
            "requisition",
            req.requisition_id,
            req.closed,
            {"requisition_id": req.requisition_id, "close_reason": req.close_reason},
            ts,
        )
    return out


def envelope(rec: SourceRecord) -> dict:
    return {
        "id": rec.event_id,
        "type": rec.event_type,
        "object": {"kind": rec.meta["kind"], "id": rec.entity_id},
        "seq": rec.sequence,
        "occurred_at": iso_ts(rec.recorded_ts),
        "effective_on": iso(rec.effective),
        "v": 1,
        "attributes": rec.payload,
    }
