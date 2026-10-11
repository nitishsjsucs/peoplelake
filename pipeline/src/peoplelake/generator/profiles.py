"""Exact event counts per generator profile (SPEC section 5.2)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Profile:
    name: str
    initial_population: int
    external_hires: int
    rehires: int
    terminations_effective: int
    terminations_rescinded: int
    transfers: int
    promotions: int
    laterals: int
    fte_changes: int
    corr_hire_date: int
    corr_hire_date_cross_month: int
    corr_term_date: int
    corr_transfer_dept: int
    corr_fte: int
    requisitions_opened: int
    requisitions_cancelled: int
    applications: int
    rejected_two_stage: int
    rejected_one_stage: int
    pending_starts: int
    offers_declined: int
    offers_rescinded: int
    merit_per_cycle: int
    adjustments: int
    reviews_per_cycle: int
    total_events: int

    @property
    def offers_accepted(self) -> int:
        return self.external_hires + self.rehires + self.pending_starts

    @property
    def offers_extended(self) -> int:
        return self.offers_accepted + self.offers_declined + self.offers_rescinded

    @property
    def requisitions_filled(self) -> int:
        return self.offers_accepted

    @property
    def corrections(self) -> int:
        return self.corr_hire_date + self.corr_term_date + self.corr_transfer_dept + self.corr_fte

    def expected_counts(self) -> dict[str, dict[str, int]]:
        """Per-source, per-event-type counts the generator must emit exactly."""
        p = self
        return {
            "hris": {
                "worker.hired": p.initial_population + p.external_hires,
                "worker.rehired": p.rehires,
                "worker.terminated": p.terminations_effective + p.terminations_rescinded,
                "worker.transferred": p.transfers,
                "worker.job_changed": p.promotions + p.laterals,
                "worker.fte_changed": p.fte_changes,
                "worker.event_corrected": p.corrections,
                "worker.event_rescinded": p.terminations_rescinded,
            },
            "ats": {
                "requisition.opened": p.requisitions_opened,
                "requisition.closed": p.requisitions_filled + p.requisitions_cancelled,
                "application.submitted": p.applications,
                "application.stage_changed": 3 * p.offers_extended + 2 * p.rejected_two_stage + p.rejected_one_stage,
                "offer.extended": p.offers_extended,
                "offer.accepted": p.offers_accepted,
                "offer.declined": p.offers_declined,
                "offer.rescinded": p.offers_rescinded,
            },
            "talent": {
                "compensation.changed": p.initial_population
                + p.external_hires
                + p.rehires
                + 3 * p.merit_per_cycle
                + p.promotions
                + p.adjustments,
                "review.submitted": 3 * p.reviews_per_cycle,
            },
        }


FULL = Profile(
    name="full",
    initial_population=4000,
    external_hires=2400,
    rehires=150,
    terminations_effective=1900,
    terminations_rescinded=60,
    transfers=1500,
    promotions=1800,
    laterals=1200,
    fte_changes=800,
    corr_hire_date=250,
    corr_hire_date_cross_month=125,
    corr_term_date=150,
    corr_transfer_dept=120,
    corr_fte=80,
    requisitions_opened=2900,
    requisitions_cancelled=100,
    applications=30000,
    rejected_two_stage=1965,
    rejected_one_stage=0,
    pending_starts=50,
    offers_declined=520,
    offers_rescinded=80,
    merit_per_cycle=3500,
    adjustments=650,
    reviews_per_cycle=3500,
    total_events=100_000,
)

SMALL = Profile(
    name="small",
    initial_population=400,
    external_hires=240,
    rehires=15,
    terminations_effective=190,
    terminations_rescinded=6,
    transfers=150,
    promotions=180,
    laterals=120,
    fte_changes=80,
    corr_hire_date=25,
    corr_hire_date_cross_month=12,
    corr_term_date=15,
    corr_transfer_dept=12,
    corr_fte=8,
    requisitions_opened=290,
    requisitions_cancelled=10,
    applications=3000,
    rejected_two_stage=196,
    rejected_one_stage=1,
    pending_starts=5,
    offers_declined=52,
    offers_rescinded=8,
    merit_per_cycle=350,
    adjustments=65,
    reviews_per_cycle=350,
    total_events=10_000,
)

PROFILES: dict[str, Profile] = {"full": FULL, "small": SMALL}


def get_profile(name: str) -> Profile:
    try:
        return PROFILES[name]
    except KeyError as exc:
        raise ValueError(f"unknown profile {name!r}; expected one of {sorted(PROFILES)}") from exc
