"""Doctor check results: PASS, FAIL, MISSING or UNKNOWN, each non-pass with the exact fix."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class Check:
    name: str
    status: str  # PASS | FAIL | MISSING | UNKNOWN | WARN | INFO
    detail: str = ""
    fix: str = ""

    def line(self) -> str:
        out = f"{self.status:8} {self.name}"
        if self.detail:
            out += f": {self.detail}"
        if self.status not in ("PASS", "INFO") and self.fix:
            out += f"\n         fix: {self.fix}"
        return out


def run_check(name: str, fn: Callable[[], Check], fix: str = "") -> Check:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - a doctor never crashes on one check
        return Check(name, "UNKNOWN", f"{type(exc).__name__}: {str(exc)[:200]}", fix)


def failed(checks: list[Check]) -> bool:
    """A doctor fails on FAIL, MISSING or UNKNOWN; PASS, WARN and INFO do not fail it."""
    return any(c.status in ("FAIL", "MISSING", "UNKNOWN") for c in checks)


def summary(checks: list[Check]) -> list[str]:
    """Counts per status, then every check that did not pass grouped under its fix, in first-seen order."""
    counts: dict[str, int] = {}
    for c in checks:
        counts[c.status] = counts.get(c.status, 0) + 1
    order = ("PASS", "FAIL", "MISSING", "UNKNOWN", "WARN", "INFO")
    lines = [f"{len(checks)} checks: " + ", ".join(f"{counts[s]} {s.lower()}" for s in order if counts.get(s))]
    groups: dict[str, list[str]] = {}
    for c in checks:
        if c.status in ("PASS", "INFO"):
            continue
        groups.setdefault(c.fix or "(no fix recorded)", []).append(f"{c.name} ({c.status})")
    if groups:
        # In README step order (the first step a fix cites); fixes that cite no step keep their order at the end.
        def first_step(fix: str) -> int:
            m = re.search(r"step (\d+)", fix)
            return int(m.group(1)) if m else 99

        lines.append("Not passing, grouped by fix in README step order:")
        for fix, names in sorted(groups.items(), key=lambda g: first_step(g[0])):
            lines.append(f"  {fix}")
            lines.extend(f"    - {n}" for n in names)
    return lines
