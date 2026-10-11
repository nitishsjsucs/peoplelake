"""HRIS source: worker lifecycle events, corrections and rescinds."""

from __future__ import annotations

from collections.abc import Callable

from ..prng import SplitMix64
from .records import SourceRecord, epoch_seconds, iso_ts, lagged, office_second
from .world import WINDOW_END, World, iso

SOURCE = "hris"


def hris_records(world: World, rng: SplitMix64, next_order: Callable[[], int]) -> list[SourceRecord]:
    out: list[SourceRecord] = []

    def emit(
        event_type: str,
        worker: str,
        effective: int,
        payload: dict,
        recorded_day: int,
        target: SourceRecord | None = None,
        target_field: str | None = None,
    ) -> SourceRecord:
        rec = SourceRecord(
            source=SOURCE,
            event_type=event_type,
            entity_id=worker,
            recorded_ts=epoch_seconds(recorded_day, office_second(rng)),
            effective=effective,
            payload=payload,
            order=next_order(),
            target=target,
            target_field=target_field,
        )
        out.append(rec)
        return rec

    def correct(target: SourceRecord, effective: int, fields: dict) -> None:
        room = WINDOW_END - target.recorded_day
        if room < 1:
            raise AssertionError("correction target recorded on the last day")
        day = target.recorded_day + rng.randint(1, min(60, room))
        emit(
            "worker.event_corrected",
            target.entity_id,
            effective,
            {"corrects_event_id": "", "corrected_fields": fields},
            day,
            target,
            "corrects_event_id",
        )

    for s in world.spells:
        event_type = "worker.rehired" if s.spell_no > 1 else "worker.hired"
        hire = emit(
            event_type,
            s.employee_id,
            s.hire_orig,
            {
                "spell_no": s.spell_no,
                "department_id": s.department_id,
                "job_code": s.job_code,
                "location_id": s.location_id,
                "fte_bp": s.fte_bp,
                "ats_candidate_id": s.offer.candidate_id if s.offer is not None else None,
                "hire_source": s.hire_source,
            },
            lagged(rng, s.hire_orig, 3),
        )
        if s.hire_corrected:
            correct(hire, s.hire_true, {"effective_date": iso(s.hire_true)})

        for c in sorted(s.changes, key=lambda c: c.date):
            if c.kind == "transfer":
                rec = emit(
                    "worker.transferred",
                    s.employee_id,
                    c.date,
                    {
                        "from_department_id": c.from_value,
                        "to_department_id": c.recorded_to if c.corrected else c.to_value,
                    },
                    lagged(rng, c.date, 3),
                )
                if c.corrected:
                    correct(rec, c.date, {"to_department_id": c.to_value})
            elif c.kind == "job":
                emit(
                    "worker.job_changed",
                    s.employee_id,
                    c.date,
                    {"from_job_code": c.from_value, "to_job_code": c.to_value, "change_type": c.change_type},
                    lagged(rng, c.date, 3),
                )
            else:
                rec = emit(
                    "worker.fte_changed",
                    s.employee_id,
                    c.date,
                    {"from_fte_bp": c.from_value, "to_fte_bp": c.recorded_to if c.corrected else c.to_value},
                    lagged(rng, c.date, 3),
                )
                if c.corrected:
                    correct(rec, c.date, {"to_fte_bp": c.to_value})

        if s.rescinded_term is not None:
            term = emit(
                "worker.terminated",
                s.employee_id,
                s.rescinded_term,
                {"termination_type": s.rescinded_termination_type, "reason_code": s.rescinded_reason_code},
                lagged(rng, s.rescinded_term, 3),
            )
            room = WINDOW_END - term.recorded_day
            day = term.recorded_day + rng.randint(1, min(30, room))
            emit(
                "worker.event_rescinded",
                s.employee_id,
                s.rescinded_term,
                {"rescinds_event_id": ""},
                day,
                term,
                "rescinds_event_id",
            )

        if s.term_orig is not None and s.term_true is not None:
            term = emit(
                "worker.terminated",
                s.employee_id,
                s.term_orig,
                {"termination_type": s.termination_type, "reason_code": s.reason_code},
                lagged(rng, s.term_orig, 3),
            )
            if s.term_corrected:
                correct(term, s.term_true, {"effective_date": iso(s.term_true)})
    return out


def envelope(rec: SourceRecord) -> dict:
    payload = dict(rec.payload)
    if rec.target is not None and rec.target_field is not None:
        payload[rec.target_field] = rec.target.event_id
    return {
        "eventId": rec.event_id,
        "eventType": rec.event_type,
        "workerId": rec.entity_id,
        "sequence": rec.sequence,
        "recordedAt": iso_ts(rec.recorded_ts),
        "effectiveDate": iso(rec.effective),
        "schemaVersion": 1,
        "data": payload,
    }
