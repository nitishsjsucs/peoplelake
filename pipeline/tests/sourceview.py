"""Test helper: a view of the emitted source envelopes (not of generator internals)."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from peoplelake.generator import Dataset

BUSINESS = {
    "worker.hired",
    "worker.rehired",
    "worker.terminated",
    "worker.transferred",
    "worker.job_changed",
    "worker.fte_changed",
}


def D(s: str) -> int:
    return date.fromisoformat(s).toordinal()


@dataclass
class HrisEvent:
    event_id: str
    event_type: str
    worker: str
    sequence: int
    recorded: str
    effective: int
    data: dict
    corrected_effective: int = 0
    corrected_data: dict = field(default_factory=dict)
    correction: HrisEvent | None = None
    rescinded_by: HrisEvent | None = None


@dataclass
class SourceView:
    hris: list[HrisEvent]
    by_id: dict[str, HrisEvent]
    business_by_worker: dict[str, list[HrisEvent]]
    ats: list[dict]
    talent: list[dict]


def view(ds: Dataset) -> SourceView:
    hris = []
    for env in ds.envelopes("hris"):
        hris.append(
            HrisEvent(
                env["eventId"],
                env["eventType"],
                env["workerId"],
                env["sequence"],
                env["recordedAt"],
                D(env["effectiveDate"]),
                env["data"],
            )
        )
    by_id = {e.event_id: e for e in hris}
    for e in hris:
        e.corrected_effective = e.effective
        e.corrected_data = dict(e.data)
    for e in hris:
        if e.event_type == "worker.event_corrected":
            target = by_id[e.data["corrects_event_id"]]
            target.correction = e
            fields = e.data["corrected_fields"]
            if "effective_date" in fields:
                target.corrected_effective = D(fields["effective_date"])
            for k in ("to_department_id", "to_fte_bp"):
                if k in fields:
                    target.corrected_data[k] = fields[k]
        elif e.event_type == "worker.event_rescinded":
            by_id[e.data["rescinds_event_id"]].rescinded_by = e
    business = defaultdict(list)
    for e in hris:
        if e.event_type in BUSINESS:
            business[e.worker].append(e)
    return SourceView(hris, by_id, dict(business), ds.envelopes("ats"), ds.envelopes("talent"))
