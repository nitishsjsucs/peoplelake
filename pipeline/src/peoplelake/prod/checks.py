"""Doctor check results: PASS, FAIL, MISSING or UNKNOWN, each non-pass with the exact fix."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class Check:
    name: str
    status: str  # PASS | FAIL | MISSING | UNKNOWN | WARN
    detail: str = ""
    fix: str = ""

    def line(self) -> str:
        out = f"{self.status:8} {self.name}"
        if self.detail:
            out += f": {self.detail}"
        if self.status != "PASS" and self.fix:
            out += f"\n         fix: {self.fix}"
        return out


def run_check(name: str, fn: Callable[[], Check], fix: str = "") -> Check:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - a doctor never crashes on one check
        return Check(name, "UNKNOWN", f"{type(exc).__name__}: {str(exc)[:200]}", fix)
