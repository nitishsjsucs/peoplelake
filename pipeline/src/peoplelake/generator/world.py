"""The true world: employees, spells, timelines, requisitions, applications and offers.

The world holds *true* business dates and values. Recorded source events (hris.py, ats.py,
talent.py) may carry an original wrong value that a later correction fixes; the oracle is
computed from the true world only (SPEC sections 5.3 and 5.5).

Dates are proleptic Gregorian ordinals (`datetime.date.toordinal()`), so arithmetic is integer only.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from datetime import date

from ..prng import SplitMix64
from .profiles import Profile
from .reference import (
    BONUS_TARGET_BP_BY_LEVEL,
    DEPARTMENT_IDS,
    FTE_VALUES_BP,
    JOB_BY_CODE,
    JOBS_BY_LEVEL,
    LOCATION_IDS,
    SALARY_BANDS,
)

SEED = 20261010


def d(y: int, m: int, day: int) -> int:
    return date(y, m, day).toordinal()


def iso(ordinal: int) -> str:
    return date.fromordinal(ordinal).isoformat()


def month_key(ordinal: int) -> tuple[int, int]:
    dt = date.fromordinal(ordinal)
    return dt.year, dt.month


def month_end(ordinal: int) -> int:
    dt = date.fromordinal(ordinal)
    nxt = date(dt.year + (dt.month == 12), dt.month % 12 + 1, 1)
    return nxt.toordinal() - 1


WINDOW_START = d(2023, 1, 1)
WINDOW_END = d(2025, 12, 31)  # data_as_of
INITIAL_HIRE_START = d(2012, 1, 1)
INITIAL_HIRE_END = d(2022, 12, 31)
EXTERNAL_HIRE_START = d(2023, 2, 1)
PENDING_START_FIRST = d(2026, 1, 5)
PENDING_START_LAST = d(2026, 1, 30)
CYCLE_YEARS = (2023, 2024, 2025)
MERIT_TENURE_DAYS = 90
REVIEW_TENURE_DAYS = 180
MIN_TENURE_BEFORE_TERMINATION = 60
REHIRE_GAP_DAYS = 135  # >= 90 days after termination even after both dates shift by up to 20 days
MAX_DATE_SHIFT = 20
CORRECTION_ROOM_DAYS = 5  # a correction target's recorded date leaves room for a later correction

WINDOW_MONTHS: tuple[tuple[int, int], ...] = tuple((y, m) for y in CYCLE_YEARS for m in range(1, 13))


class GenerationError(RuntimeError):
    """Raised when an eligibility pool is too small to produce the exact profile counts."""


@dataclass
class Offer:
    key: int
    requisition: Requisition
    status: str  # accepted | declined | rescinded
    applied: int
    stage_dates: tuple[int, int, int]
    extended: int
    decision: int
    proposed_start: int
    offer_id: str = ""
    application_id: str = ""
    candidate_id: str = ""


@dataclass
class Requisition:
    key: int
    department_id: str
    job_code: str
    opened: int
    closed: int | None = None
    close_reason: str | None = None  # filled | cancelled
    accepted_offer: Offer | None = None
    requisition_id: str = ""

    def offer_limit(self) -> int:
        """Exclusive upper bound for the dates of other offers' events on this requisition."""
        if self.accepted_offer is not None:
            return self.accepted_offer.applied
        if self.closed is not None:
            return self.closed
        return WINDOW_END + 1

    def application_limit(self) -> int:
        return self.closed if self.closed is not None else WINDOW_END + 1


@dataclass
class Application:
    key: int
    requisition: Requisition
    submitted: int
    stages: list[tuple[int, str, str]]
    offer: Offer | None = None
    application_id: str = ""
    candidate_id: str = ""


@dataclass
class Change:
    """A transfer, job change or FTE change inside a spell (true values; `recorded_to` may differ)."""

    kind: str  # transfer | job | fte
    date: int
    change_type: str | None = None  # promotion | lateral for job changes
    from_value: str | int | None = None
    to_value: str | int | None = None
    recorded_to: str | int | None = None  # original recorded value when a correction fixes it later

    @property
    def corrected(self) -> bool:
        return self.recorded_to is not None and self.recorded_to != self.to_value


@dataclass
class Spell:
    employee_id: str
    spell_no: int
    hire_orig: int
    department_id: str
    job_code: str
    location_id: str
    fte_bp: int
    hire_source: str  # initial_load | external | rehire
    offer: Offer | None = None
    hire_true: int = 0
    term_orig: int | None = None
    term_true: int | None = None
    termination_type: str | None = None
    reason_code: str | None = None
    rescinded_term: int | None = None
    rescinded_termination_type: str | None = None
    rescinded_reason_code: str | None = None
    changes: list[Change] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.hire_true == 0:
            self.hire_true = self.hire_orig

    @property
    def hire_corrected(self) -> bool:
        return self.hire_true != self.hire_orig

    @property
    def term_corrected(self) -> bool:
        return self.term_orig is not None and self.term_true != self.term_orig

    @property
    def in_window_hire(self) -> bool:
        return self.hire_source != "initial_load"

    def interior(self) -> tuple[int, int]:
        """Open interval (lo, hi) inside which every other event of the spell must fall."""
        lo = max(self.hire_orig, self.hire_true)
        hi = WINDOW_END + 1
        if self.term_orig is not None and self.term_true is not None:
            hi = min(self.term_orig, self.term_true)
        return lo, hi

    def hris_dates(self) -> set[int]:
        dates = {self.hire_orig, self.hire_true}
        if self.term_orig is not None and self.term_true is not None:
            dates |= {self.term_orig, self.term_true}
        if self.rescinded_term is not None:
            dates.add(self.rescinded_term)
        dates |= {c.date for c in self.changes}
        return dates

    def active_on(self, day: int) -> bool:
        return self.hire_true <= day and (self.term_true is None or self.term_true > day)

    def state_on(self, day: int) -> tuple[str, str, int]:
        """True (department_id, job_code, fte_bp) on a day inside the spell."""
        dept, job, fte = self.department_id, self.job_code, self.fte_bp
        for c in sorted(self.changes, key=lambda c: c.date):
            if c.date > day:
                break
            if c.kind == "transfer":
                dept = str(c.to_value)
            elif c.kind == "job":
                job = str(c.to_value)
            else:
                fte = int(c.to_value)  # type: ignore[arg-type]
        return dept, job, fte


@dataclass
class CompEvent:
    employee_id: str
    spell_no: int
    date: int
    reason: str  # initial | hire | rehire | merit | promotion | adjustment
    base_salary: int = 0
    bonus_target_bp: int = 0
    change_id: str = ""


@dataclass
class ReviewEvent:
    employee_id: str
    spell_no: int
    date: int
    cycle: str
    rating: int
    reviewer_id: str
    review_id: str = ""


@dataclass
class World:
    profile: Profile
    spells: list[Spell]
    requisitions: list[Requisition]
    applications: list[Application]
    offers: list[Offer]
    comp_events: list[CompEvent]
    reviews: list[ReviewEvent]

    def spells_by_employee(self) -> dict[str, list[Spell]]:
        out: dict[str, list[Spell]] = {}
        for s in self.spells:
            out.setdefault(s.employee_id, []).append(s)
        for v in out.values():
            v.sort(key=lambda s: s.spell_no)
        return out


# ---------------------------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------------------------


def _pick_job(rng: SplitMix64) -> str:
    level = rng.weighted([(1, 30), (2, 35), (3, 25), (4, 10)])
    return rng.choice(JOBS_BY_LEVEL[level])


def _pick_fte(rng: SplitMix64) -> int:
    return rng.weighted([(10000, 80), (8000, 10), (6000, 5), (5000, 5)])


def _round100(x: int) -> int:
    return (x + 50) // 100 * 100


class _Builder:
    def __init__(self, profile: Profile) -> None:
        self.p = profile
        root = SplitMix64(SEED)
        self.root = root.fork(f"profile:{profile.name}")
        self.spells: list[Spell] = []
        self.requisitions: list[Requisition] = []
        self.offers: list[Offer] = []
        self.applications: list[Application] = []
        self.comp: list[CompEvent] = []
        self.reviews: list[ReviewEvent] = []
        self._key = 0

    def rng(self, label: str) -> SplitMix64:
        return self.root.fork(label)

    def next_key(self) -> int:
        self._key += 1
        return self._key

    # -- spells ---------------------------------------------------------------------------------

    def initial_population(self) -> None:
        rng = self.rng("initial")
        for i in range(1, self.p.initial_population + 1):
            self.spells.append(
                Spell(
                    employee_id=f"E{i:06d}",
                    spell_no=1,
                    hire_orig=rng.randint(INITIAL_HIRE_START, INITIAL_HIRE_END),
                    department_id=rng.choice(DEPARTMENT_IDS),
                    job_code=_pick_job(rng),
                    location_id=rng.choice(LOCATION_IDS),
                    fte_bp=_pick_fte(rng),
                    hire_source="initial_load",
                )
            )

    def _accepted_offer(self, rng: SplitMix64, start: int, dept: str, job: str) -> Offer:
        """Requisition + offered application timeline for an accepted offer starting on `start`."""
        max_open_gap = min(90, start - WINDOW_START)
        if max_open_gap < 30:
            raise GenerationError(f"start {iso(start)} leaves no room to open a requisition in window")
        gap_open = rng.randint(30, max_open_gap)
        min_dec = max(14, start - WINDOW_END)
        max_dec = min(45, gap_open - 16)
        if max_dec < min_dec:
            gap_open = max_open_gap
            max_dec = min(45, gap_open - 16)
            if max_dec < min_dec:
                raise GenerationError(f"no decision date fits start {iso(start)}")
        gap_dec = rng.randint(min_dec, max_dec)
        opened = start - gap_open
        decision = start - gap_dec
        span = decision - opened
        offsets = sorted(rng.sample(range(1, span), 5))
        applied, s1, s2, s3, extended = (opened + o for o in offsets)
        req = Requisition(key=self.next_key(), department_id=dept, job_code=job, opened=opened)
        offer = Offer(
            key=self.next_key(),
            requisition=req,
            status="accepted",
            applied=applied,
            stage_dates=(s1, s2, s3),
            extended=extended,
            decision=decision,
            proposed_start=start,
        )
        req.accepted_offer = offer
        req.closed = decision
        req.close_reason = "filled"
        self.requisitions.append(req)
        self.offers.append(offer)
        return offer

    def external_hires(self) -> None:
        rng = self.rng("external")
        base = self.p.initial_population
        for i in range(1, self.p.external_hires + 1):
            start = rng.randint(EXTERNAL_HIRE_START, WINDOW_END)
            dept, job = rng.choice(DEPARTMENT_IDS), _pick_job(rng)
            offer = self._accepted_offer(rng, start, dept, job)
            self.spells.append(
                Spell(
                    employee_id=f"E{base + i:06d}",
                    spell_no=1,
                    hire_orig=start,
                    department_id=dept,
                    job_code=job,
                    location_id=rng.choice(LOCATION_IDS),
                    fte_bp=_pick_fte(rng),
                    hire_source="external",
                    offer=offer,
                )
            )

    def terminations(self) -> None:
        rng = self.rng("terminations")
        first_spells = [s for s in self.spells if s.spell_no == 1]
        needed = self.p.terminations_effective
        done = 0
        attempts = 0
        while done < needed:
            attempts += 1
            if attempts > needed * 200:
                raise GenerationError("could not place effective terminations")
            day = rng.randint(WINDOW_START + 1, WINDOW_END)
            s = rng.choice(first_spells)
            if s.term_orig is not None or s.hire_orig + MIN_TENURE_BEFORE_TERMINATION + MAX_DATE_SHIFT > day:
                continue
            s.term_orig = s.term_true = day
            s.termination_type = rng.weighted([("voluntary", 70), ("involuntary", 30)])
            s.reason_code = rng.choice(
                ("RESIGN_CAREER", "RESIGN_PERSONAL", "RELOCATION", "PERFORMANCE", "RESTRUCTURE")
                if s.termination_type == "involuntary"
                else ("RESIGN_CAREER", "RESIGN_PERSONAL", "RELOCATION", "RETIREMENT")
            )
            done += 1

    def rescinded_terminations(self) -> None:
        rng = self.rng("rescinded")
        pool = [s for s in self.spells if s.spell_no == 1 and s.term_orig is None]
        chosen = 0
        attempts = 0
        while chosen < self.p.terminations_rescinded:
            attempts += 1
            if attempts > 100_000:
                raise GenerationError("could not place rescinded terminations")
            s = rng.choice(pool)
            if s.rescinded_term is not None:
                continue
            lo = max(WINDOW_START + 1, s.hire_orig + MIN_TENURE_BEFORE_TERMINATION + MAX_DATE_SHIFT)
            hi = WINDOW_END - CORRECTION_ROOM_DAYS
            if lo > hi:
                continue
            s.rescinded_term = rng.randint(lo, hi)
            s.rescinded_termination_type = "voluntary"
            s.rescinded_reason_code = "RESIGN_PERSONAL"
            chosen += 1

    def rehires(self) -> None:
        rng = self.rng("rehires")
        pool = [s for s in self.spells if s.term_orig is not None and s.term_orig + REHIRE_GAP_DAYS <= WINDOW_END]
        if len(pool) < self.p.rehires:
            raise GenerationError(f"rehire pool {len(pool)} < {self.p.rehires}")
        for s in sorted(rng.sample(pool, self.p.rehires), key=lambda s: s.employee_id):
            assert s.term_orig is not None
            start = rng.randint(max(s.term_orig + REHIRE_GAP_DAYS, EXTERNAL_HIRE_START), WINDOW_END)
            dept, job = rng.choice(DEPARTMENT_IDS), _pick_job(rng)
            offer = self._accepted_offer(rng, start, dept, job)
            self.spells.append(
                Spell(
                    employee_id=s.employee_id,
                    spell_no=2,
                    hire_orig=start,
                    department_id=dept,
                    job_code=job,
                    location_id=s.location_id,
                    fte_bp=_pick_fte(rng),
                    hire_source="rehire",
                    offer=offer,
                )
            )

    def pending_starts(self) -> None:
        rng = self.rng("pending")
        for _ in range(self.p.pending_starts):
            start = rng.randint(PENDING_START_FIRST, PENDING_START_LAST)
            self._accepted_offer(rng, start, rng.choice(DEPARTMENT_IDS), _pick_job(rng))

    # -- corrections of hire and termination dates -------------------------------------------------

    def hire_date_corrections(self) -> None:
        rng = self.rng("corr-hire")
        cands = [s for s in self.spells if s.in_window_hire and s.hire_orig <= WINDOW_END - CORRECTION_ROOM_DAYS]
        rng.shuffle(cands)
        cross_needed = self.p.corr_hire_date_cross_month
        same_needed = self.p.corr_hire_date - cross_needed

        def options(s: Spell, cross: bool) -> list[int]:
            assert s.offer is not None
            out = []
            for shift in range(-MAX_DATE_SHIFT, MAX_DATE_SHIFT + 1):
                t = s.hire_orig + shift
                if shift == 0 or t <= s.offer.decision or t < EXTERNAL_HIRE_START or t > WINDOW_END:
                    continue
                if (month_key(t) != month_key(s.hire_orig)) != cross:
                    continue
                if cross and shift < 0:
                    continue  # crossing corrections move originals near a month end forward
                out.append(t)
            return out

        for s in cands:
            if cross_needed == 0 and same_needed == 0:
                break
            if cross_needed > 0:
                opts = options(s, True)
                if opts:
                    s.hire_true = rng.choice(opts)
                    cross_needed -= 1
                    continue
            if same_needed > 0:
                opts = options(s, False)
                if opts:
                    s.hire_true = rng.choice(opts)
                    same_needed -= 1
        if cross_needed or same_needed:
            raise GenerationError("not enough hires near month ends for hire-date corrections")

    def termination_date_corrections(self) -> None:
        rng = self.rng("corr-term")
        rehire_start = {s.employee_id: s for s in self.spells if s.spell_no == 2}
        cands = [s for s in self.spells if s.term_orig is not None and s.term_orig <= WINDOW_END - CORRECTION_ROOM_DAYS]
        picked = 0
        for s in rng.sample(cands, len(cands)):
            if picked == self.p.corr_term_date:
                break
            assert s.term_orig is not None
            lo = max(WINDOW_START, max(s.hire_orig, s.hire_true) + MIN_TENURE_BEFORE_TERMINATION)
            hi = WINDOW_END
            nxt = rehire_start.get(s.employee_id)
            if nxt is not None:
                hi = min(hi, min(nxt.hire_orig, nxt.hire_true) - 90)
            opts = [
                s.term_orig + k
                for k in range(-MAX_DATE_SHIFT, MAX_DATE_SHIFT + 1)
                if k != 0 and lo <= s.term_orig + k <= hi
            ]
            if not opts:
                continue
            s.term_true = rng.choice(opts)
            picked += 1
        if picked < self.p.corr_term_date:
            raise GenerationError("not enough terminations for termination-date corrections")

    # -- transfers, job and FTE changes -----------------------------------------------------------

    def _interiors(self) -> tuple[list[Spell], list[int], list[int]]:
        """Spells with a non-empty in-window interior, their first day and cumulative lengths."""
        spells, starts, cum = [], [], []
        total = 0
        for s in self.spells:
            lo, hi = s.interior()
            first = max(lo + 1, WINDOW_START)
            last = min(hi - 1, WINDOW_END)
            if last < first:
                continue
            total += last - first + 1
            spells.append(s)
            starts.append(first)
            cum.append(total)
        return spells, starts, cum

    def _random_interior_day(self, rng: SplitMix64, spells: list[Spell], starts: list[int], cum: list[int]):
        x = rng.below(cum[-1])
        i = bisect.bisect_right(cum, x)
        prev = cum[i - 1] if i > 0 else 0
        return spells[i], starts[i] + (x - prev)

    def changes(self) -> None:
        rng = self.rng("changes")
        spells, starts, cum = self._interiors()
        plan = (
            [("transfer", None)] * self.p.transfers
            + [("job", "promotion")] * self.p.promotions
            + [("job", "lateral")] * self.p.laterals
            + [("fte", None)] * self.p.fte_changes
        )
        for kind, change_type in plan:
            for _ in range(10_000):
                s, day = self._random_interior_day(rng, spells, starts, cum)
                if day in s.hris_dates():
                    continue
                if change_type == "promotion":
                    if date.fromordinal(day).strftime("%m-%d") == "04-01":
                        continue  # merit day: one compensation change per employee per day
                    if sum(1 for c in s.changes if c.change_type == "promotion") >= 2:
                        continue
                s.changes.append(Change(kind=kind, date=day, change_type=change_type))
                break
            else:
                raise GenerationError(f"could not place a {kind} change")
        # Walk each spell in date order and assign true from/to values.
        for s in self.spells:
            dept, job, fte = s.department_id, s.job_code, s.fte_bp
            for c in sorted(s.changes, key=lambda c: c.date):
                if c.kind == "transfer":
                    to = rng.choice([x for x in DEPARTMENT_IDS if x != dept])
                    c.from_value, c.to_value = dept, to
                    dept = to
                elif c.kind == "job":
                    level = JOB_BY_CODE[job].job_level
                    if c.change_type == "promotion":
                        to = rng.choice(JOBS_BY_LEVEL[level + 1])
                    else:
                        to = rng.choice([x for x in JOBS_BY_LEVEL[level] if x != job])
                    c.from_value, c.to_value = job, to
                    job = to
                else:
                    to = rng.choice([x for x in FTE_VALUES_BP if x != fte])
                    c.from_value, c.to_value = fte, to
                    fte = to

    def value_corrections(self) -> None:
        rng = self.rng("corr-values")
        for kind, needed in (("transfer", self.p.corr_transfer_dept), ("fte", self.p.corr_fte)):
            pool = [
                c
                for s in self.spells
                for c in s.changes
                if c.kind == kind and c.date <= WINDOW_END - CORRECTION_ROOM_DAYS
            ]
            if len(pool) < needed:
                raise GenerationError(f"{kind} correction pool {len(pool)} < {needed}")
            values = DEPARTMENT_IDS if kind == "transfer" else FTE_VALUES_BP
            for c in rng.sample(pool, needed):
                c.recorded_to = rng.choice([v for v in values if v not in (c.from_value, c.to_value)])

    # -- talent ----------------------------------------------------------------------------------

    def talent(self) -> None:
        rng = self.rng("talent")
        comp_dates: dict[str, set[int]] = {}

        def add_comp(s: Spell, day: int, reason: str) -> None:
            if day in comp_dates.setdefault(s.employee_id, set()):
                raise GenerationError(f"two compensation changes for {s.employee_id} on {iso(day)}")
            comp_dates[s.employee_id].add(day)
            self.comp.append(CompEvent(s.employee_id, s.spell_no, day, reason))

        for s in self.spells:
            reason = {"initial_load": "initial", "external": "hire", "rehire": "rehire"}[s.hire_source]
            add_comp(s, s.hire_true, reason)
        for s in self.spells:
            for c in s.changes:
                if c.change_type == "promotion":
                    add_comp(s, c.date, "promotion")

        def eligible(s: Spell, day: int, tenure: int) -> bool:
            lo, hi = s.interior()
            return s.hire_true + tenure <= day and lo < day < hi

        for year in CYCLE_YEARS:
            merit_day = d(year, 4, 1)
            pool = [s for s in self.spells if eligible(s, merit_day, MERIT_TENURE_DAYS)]
            if len(pool) < self.p.merit_per_cycle:
                raise GenerationError(f"merit pool {year}: {len(pool)} < {self.p.merit_per_cycle}")
            for s in sorted(rng.sample(pool, self.p.merit_per_cycle), key=lambda s: s.employee_id):
                add_comp(s, merit_day, "merit")

        spells, starts, cum = self._interiors()
        placed = 0
        for _ in range(self.p.adjustments * 1000):
            if placed == self.p.adjustments:
                break
            s, day = self._random_interior_day(rng, spells, starts, cum)
            if day in comp_dates.get(s.employee_id, set()):
                continue
            add_comp(s, day, "adjustment")
            placed += 1
        if placed < self.p.adjustments:
            raise GenerationError("could not place compensation adjustments")

        everyone = sorted({s.employee_id for s in self.spells})
        for year in CYCLE_YEARS:
            review_day = d(year, 12, 15)
            pool = [s for s in self.spells if eligible(s, review_day, REVIEW_TENURE_DAYS)]
            if len(pool) < self.p.reviews_per_cycle:
                raise GenerationError(f"review pool {year}: {len(pool)} < {self.p.reviews_per_cycle}")
            for s in sorted(rng.sample(pool, self.p.reviews_per_cycle), key=lambda s: s.employee_id):
                reviewer = s.employee_id
                while reviewer == s.employee_id:
                    reviewer = rng.choice(everyone)
                self.reviews.append(
                    ReviewEvent(
                        employee_id=s.employee_id,
                        spell_no=s.spell_no,
                        date=review_day,
                        cycle=str(year),
                        rating=rng.weighted([(1, 5), (2, 15), (3, 50), (4, 22), (5, 8)]),
                        reviewer_id=reviewer,
                    )
                )

        # Compensation values: walk each employee's changes in date order.
        by_spell: dict[tuple[str, int], Spell] = {(s.employee_id, s.spell_no): s for s in self.spells}
        by_emp: dict[str, list[CompEvent]] = {}
        for ev in self.comp:
            by_emp.setdefault(ev.employee_id, []).append(ev)
        for emp in sorted(by_emp):
            base = 0
            bonus = 0
            for ev in sorted(by_emp[emp], key=lambda e: e.date):
                s = by_spell[(ev.employee_id, ev.spell_no)]
                _, job, _ = s.state_on(ev.date)
                level = JOB_BY_CODE[job].job_level
                if ev.reason in ("initial", "hire", "rehire"):
                    lo, hi = SALARY_BANDS[level]
                    base = rng.randint(lo // 100, hi // 100) * 100
                    bonus = BONUS_TARGET_BP_BY_LEVEL[level]
                elif ev.reason == "merit":
                    base = _round100(base * (100 + rng.randint(2, 5)) // 100)
                elif ev.reason == "promotion":
                    base = _round100(base * (100 + rng.randint(8, 15)) // 100)
                    bonus = BONUS_TARGET_BP_BY_LEVEL[level]
                else:
                    base = _round100(base * (100 + rng.randint(1, 6)) // 100)
                ev.base_salary, ev.bonus_target_bp = base, bonus

    # -- recruiting -------------------------------------------------------------------------------

    def requisitions_without_hires(self) -> None:
        rng = self.rng("reqs")
        for _ in range(self.p.requisitions_cancelled):
            opened = rng.randint(WINDOW_START, d(2025, 10, 1))
            closed = min(opened + rng.randint(20, 120), WINDOW_END)
            self.requisitions.append(
                Requisition(
                    key=self.next_key(),
                    department_id=rng.choice(DEPARTMENT_IDS),
                    job_code=_pick_job(rng),
                    opened=opened,
                    closed=closed,
                    close_reason="cancelled",
                )
            )
        still_open = self.p.requisitions_opened - len(self.requisitions)
        if still_open < 0:
            raise GenerationError("more filled and cancelled requisitions than opened")
        for _ in range(still_open):
            self.requisitions.append(
                Requisition(
                    key=self.next_key(),
                    department_id=rng.choice(DEPARTMENT_IDS),
                    job_code=_pick_job(rng),
                    opened=rng.randint(d(2025, 6, 1), d(2025, 12, 20)),
                )
            )

    def unsuccessful_offers(self) -> None:
        rng = self.rng("offers")
        plan = ["declined"] * self.p.offers_declined + ["rescinded"] * self.p.offers_rescinded
        for status in plan:
            for _ in range(10_000):
                req = rng.choice(self.requisitions)
                limit = req.offer_limit()
                if limit - req.opened - 1 < 7:
                    continue
                offsets = sorted(rng.sample(range(1, limit - req.opened), 6))
                applied, s1, s2, s3, extended, decision = (req.opened + o for o in offsets)
                if decision > WINDOW_END:
                    continue
                self.offers.append(
                    Offer(
                        key=self.next_key(),
                        requisition=req,
                        status=status,
                        applied=applied,
                        stage_dates=(s1, s2, s3),
                        extended=extended,
                        decision=decision,
                        proposed_start=decision + rng.randint(14, 45),
                    )
                )
                break
            else:
                raise GenerationError("could not place an unsuccessful offer")

    def applications_and_candidates(self) -> None:
        rng = self.rng("applications")
        for offer in self.offers:
            stages = [
                (offer.stage_dates[0], "applied", "screen"),
                (offer.stage_dates[1], "screen", "interview"),
                (offer.stage_dates[2], "interview", "offer"),
            ]
            self.applications.append(
                Application(
                    key=self.next_key(),
                    requisition=offer.requisition,
                    submitted=offer.applied,
                    stages=stages,
                    offer=offer,
                )
            )
        plain = self.p.applications - len(self.applications)
        if plain < self.p.rejected_two_stage + self.p.rejected_one_stage:
            raise GenerationError("not enough applications for rejections")
        kinds = (
            ["two"] * self.p.rejected_two_stage
            + ["one"] * self.p.rejected_one_stage
            + ["none"] * (plain - self.p.rejected_two_stage - self.p.rejected_one_stage)
        )
        for kind in kinds:
            need = {"two": 3, "one": 2, "none": 1}[kind]
            for _ in range(10_000):
                req = rng.choice(self.requisitions)
                limit = req.application_limit()
                if limit - req.opened - 1 < need:
                    continue
                days = sorted(req.opened + o for o in rng.sample(range(1, limit - req.opened), need))
                if days[-1] > WINDOW_END:
                    continue
                if kind == "two":
                    stages = [(days[1], "applied", "screen"), (days[2], "screen", "rejected")]
                elif kind == "one":
                    stages = [(days[1], "applied", "rejected")]
                else:
                    stages = []
                self.applications.append(
                    Application(key=self.next_key(), requisition=req, submitted=days[0], stages=stages)
                )
                break
            else:
                raise GenerationError("could not place an application")

    def assign_ids(self) -> None:
        for i, req in enumerate(sorted(self.requisitions, key=lambda r: (r.opened, r.key)), start=1):
            req.requisition_id = f"Q{i:06d}"
        for i, app in enumerate(sorted(self.applications, key=lambda a: (a.submitted, a.key)), start=1):
            app.application_id = f"A{i:06d}"
            app.candidate_id = f"C{i:06d}"
            if app.offer is not None:
                app.offer.application_id = app.application_id
                app.offer.candidate_id = app.candidate_id
        for i, offer in enumerate(sorted(self.offers, key=lambda o: (o.extended, o.key)), start=1):
            offer.offer_id = f"O{i:06d}"
        comp_sorted = sorted(self.comp, key=lambda c: (c.date, c.employee_id))
        for i, ev in enumerate(comp_sorted, start=1):
            ev.change_id = f"K{i:06d}"
        self.comp = comp_sorted
        reviews_sorted = sorted(self.reviews, key=lambda r: (r.date, r.employee_id))
        for i, rv in enumerate(reviews_sorted, start=1):
            rv.review_id = f"V{i:06d}"
        self.reviews = reviews_sorted

    def build(self) -> World:
        self.initial_population()
        self.external_hires()
        self.terminations()
        self.rescinded_terminations()
        self.rehires()
        self.pending_starts()
        self.hire_date_corrections()
        self.termination_date_corrections()
        self.changes()
        self.value_corrections()
        self.talent()
        self.requisitions_without_hires()
        self.unsuccessful_offers()
        self.applications_and_candidates()
        self.assign_ids()
        self.spells.sort(key=lambda s: (s.employee_id, s.spell_no))
        return World(
            profile=self.p,
            spells=self.spells,
            requisitions=sorted(self.requisitions, key=lambda r: r.requisition_id),
            applications=sorted(self.applications, key=lambda a: a.application_id),
            offers=sorted(self.offers, key=lambda o: o.offer_id),
            comp_events=self.comp,
            reviews=self.reviews,
        )


def build_world(profile: Profile) -> World:
    return _Builder(profile).build()
