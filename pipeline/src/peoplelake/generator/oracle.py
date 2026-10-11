"""Expected metrics and expected reconciliation results, computed from the true world (never from events).

Rows: every month 2023-01..2025-12 x (D01..D12 plus ALL) = 468 per profile (SPEC section 5.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from .reference import DEPARTMENT_IDS
from .world import WINDOW_END, WINDOW_MONTHS, Spell, World, d, month_end

ORACLE_COLUMNS: tuple[str, ...] = (
    "profile",
    "month",
    "department_id",
    "headcount",
    "fte",
    "hires",
    "rehires",
    "departures",
    "transfers_in",
    "transfers_out",
    "offers_extended",
    "offers_accepted",
    "offers_declined",
    "offer_acceptance_rate",
)
COUNT_FIELDS: tuple[str, ...] = (
    "headcount",
    "hires",
    "rehires",
    "departures",
    "transfers_in",
    "transfers_out",
    "offers_extended",
    "offers_accepted",
    "offers_declined",
)


def fmt_micro(micro: int) -> str:
    """Non-negative integer in millionths as a decimal string with 6 places."""
    if micro < 0:
        raise ValueError("negative")
    return f"{micro // 1_000_000}.{micro % 1_000_000:06d}"


def acceptance_ppm(accepted: int, declined: int) -> int | None:
    total = accepted + declined
    if total == 0:
        return None
    return (2 * 1_000_000 * accepted + total) // (2 * total)  # round half up


@dataclass
class _Cell:
    headcount: int = 0
    fte_bp: int = 0
    hires: int = 0
    rehires: int = 0
    departures: int = 0
    transfers_in: int = 0
    transfers_out: int = 0
    offers_extended: int = 0
    offers_accepted: int = 0
    offers_declined: int = 0


class _Timeline:
    """True (department, fte) of a spell on any day, with changes pre-sorted."""

    def __init__(self, spell: Spell) -> None:
        self.spell = spell
        self.changes = sorted(spell.changes, key=lambda c: c.date)

    def dept_fte(self, day: int) -> tuple[str, int]:
        dept, fte = self.spell.department_id, self.spell.fte_bp
        for c in self.changes:
            if c.date > day:
                break
            if c.kind == "transfer":
                dept = str(c.to_value)
            elif c.kind == "fte":
                fte = int(c.to_value)  # type: ignore[arg-type]
        return dept, fte


def headcount_on(world: World, day: int) -> int:
    return sum(1 for s in world.spells if s.active_on(day))


def oracle_rows(world: World) -> list[dict[str, str]]:
    keys = [(y, m) for (y, m) in WINDOW_MONTHS]
    cells: dict[tuple[tuple[int, int], str], _Cell] = {(k, dep): _Cell() for k in keys for dep in DEPARTMENT_IDS}
    timelines = [_Timeline(s) for s in world.spells]

    def ym(day: int) -> tuple[int, int]:
        dt = date.fromordinal(day)
        return dt.year, dt.month

    for k in keys:
        me = month_end(d(k[0], k[1], 1))
        for t in timelines:
            if t.spell.active_on(me):
                dept, fte = t.dept_fte(me)
                cell = cells[(k, dept)]
                cell.headcount += 1
                cell.fte_bp += fte
    for t in timelines:
        s = t.spell
        k = ym(s.hire_true)
        if (k, s.department_id) in cells:
            cells[(k, s.department_id)].hires += 1
            if s.spell_no > 1:
                cells[(k, s.department_id)].rehires += 1
        if s.term_true is not None:
            k = ym(s.term_true)
            dept, _ = t.dept_fte(s.term_true)
            cells[(k, dept)].departures += 1
        for c in t.changes:
            if c.kind == "transfer":
                k = ym(c.date)
                cells[(k, str(c.from_value))].transfers_out += 1
                cells[(k, str(c.to_value))].transfers_in += 1
    for o in world.offers:
        dept = o.requisition.department_id
        cells[(ym(o.extended), dept)].offers_extended += 1
        if o.status == "accepted":
            cells[(ym(o.decision), dept)].offers_accepted += 1
        elif o.status == "declined":
            cells[(ym(o.decision), dept)].offers_declined += 1

    rows: list[dict[str, str]] = []
    for k in keys:
        month = date(k[0], k[1], 1).isoformat()
        total = _Cell()
        transfers = 0
        for dep in DEPARTMENT_IDS:
            c = cells[(k, dep)]
            rows.append(_row(world.profile.name, month, dep, c))
            for f in COUNT_FIELDS:
                setattr(total, f, getattr(total, f) + getattr(c, f))
            total.fte_bp += c.fte_bp
            transfers += c.transfers_in
        total.transfers_in = total.transfers_out = transfers
        rows.append(_row(world.profile.name, month, "ALL", total))
    rows.sort(key=lambda r: (r["profile"], r["month"], r["department_id"]))
    return rows


def _row(profile: str, month: str, dept: str, c: _Cell) -> dict[str, str]:
    ppm = acceptance_ppm(c.offers_accepted, c.offers_declined)
    row = {"profile": profile, "month": month, "department_id": dept}
    for f in COUNT_FIELDS:
        row[f] = str(getattr(c, f))
    row["fte"] = fmt_micro(c.fte_bp * 100)
    row["offer_acceptance_rate"] = "" if ppm is None else fmt_micro(ppm)
    return {col: row[col] for col in ORACLE_COLUMNS}


def oracle_csv(rows: list[dict[str, str]]) -> str:
    out = [",".join(ORACLE_COLUMNS)]
    out += [",".join(r[c] for c in ORACLE_COLUMNS) for r in rows]
    return "\n".join(out) + "\n"


@dataclass(frozen=True)
class OracleTotals:
    headcount_start: int  # 2022-12-31
    headcount_end: int  # 2025-12-31
    hires_in_window: int
    rehires_in_window: int
    departures_in_window: int
    offers_accepted: int
    offers_declined: int
    acceptance_rate: str
    employees: int
    spells: int


def oracle_totals(world: World) -> OracleTotals:
    start = d(2022, 12, 31)
    in_window = [s for s in world.spells if start < s.hire_true <= WINDOW_END]
    acc = sum(1 for o in world.offers if o.status == "accepted")
    dec = sum(1 for o in world.offers if o.status == "declined")
    ppm = acceptance_ppm(acc, dec)
    return OracleTotals(
        headcount_start=headcount_on(world, start),
        headcount_end=headcount_on(world, WINDOW_END),
        hires_in_window=len(in_window),
        rehires_in_window=sum(1 for s in in_window if s.spell_no > 1),
        departures_in_window=sum(
            1 for s in world.spells if s.term_true is not None and start < s.term_true <= WINDOW_END
        ),
        offers_accepted=acc,
        offers_declined=dec,
        acceptance_rate=fmt_micro(ppm) if ppm is not None else "",
        employees=len({s.employee_id for s in world.spells}),
        spells=len(world.spells),
    )


def expected_r6_violations(world: World) -> list[str]:
    """R6 offer to hire, evaluated on the true world (SPEC 11.6). Must be empty."""
    out = []
    by_candidate: dict[str, list[Spell]] = {}
    for s in world.spells:
        if s.offer is not None:
            by_candidate.setdefault(s.offer.candidate_id, []).append(s)
    accepted_by_candidate: dict[str, int] = {}
    for o in world.offers:
        if o.status == "accepted":
            accepted_by_candidate[o.candidate_id] = accepted_by_candidate.get(o.candidate_id, 0) + 1
            if o.proposed_start <= WINDOW_END:
                hires = [s for s in by_candidate.get(o.candidate_id, []) if abs(s.hire_true - o.proposed_start) <= 30]
                if len(hires) != 1:
                    out.append(f"offer {o.offer_id}: {len(hires)} matching hires")
    for s in world.spells:
        if s.in_window_hire:
            cand = s.offer.candidate_id if s.offer else None
            if cand is None or accepted_by_candidate.get(cand, 0) != 1:
                out.append(f"spell {s.employee_id}/{s.spell_no}: accepted offers != 1")
    return out


def expected_r11_violations(world: World) -> list[str]:
    """R11 open anomalies on the true world: inferred spell ends and talent events outside spells."""
    out = []
    spells = world.spells_by_employee()
    for emp, ss in spells.items():
        for prev, nxt in zip(ss, ss[1:], strict=False):
            if prev.term_true is None or prev.term_true >= nxt.hire_true:
                out.append(f"{emp}: spell {nxt.spell_no} starts while spell {prev.spell_no} is open")

    def inside(emp: str, day: int) -> bool:
        return any(s.hire_true <= day and (s.term_true is None or day <= s.term_true) for s in spells.get(emp, []))

    for ev in world.comp_events:
        if not inside(ev.employee_id, ev.date):
            out.append(f"compensation {ev.change_id} outside a spell")
    for rv in world.reviews:
        if not inside(rv.employee_id, rv.date):
            out.append(f"review {rv.review_id} outside a spell")
    return out
