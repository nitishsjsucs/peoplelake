"""`peoplelake dev bq-compile` counts, parses and lints only what this compile wrote: a reused target
directory (the default `.data/bq-compile`) keeps files of models and tests that no longer exist."""

from __future__ import annotations

from pathlib import Path

from peoplelake.devtools import bq_offline
from peoplelake.warehouse.dbt_runner import DbtOutcome

WRITTEN = {
    "models/core/fct_a.sql": "select 1 as a",
    "models/staging/stg_b.sql": "select 2 as b",
    "tests/reconciliation/recon_c.sql": "select * from t where 1 = 0",
    "tests/reporting/rpt_d.sql": "select * from t where 2 = 0",
}


class FakeDbt:
    """Writes this compile's output the way `dbt compile` does, and leaves anything else in place."""

    def __init__(self, *, target: str, target_path: Path) -> None:
        self.target_path = target_path

    def invoke(self, args: list[str]) -> DbtOutcome:
        compiled = self.target_path / "compiled" / "peoplelake"
        for rel, sql in WRITTEN.items():
            (compiled / rel).parent.mkdir(parents=True, exist_ok=True)
            (compiled / rel).write_text(sql)
        return DbtOutcome(command=args[0], success=True, elapsed_ms=0)


def test_a_reused_target_counts_only_this_compile(tmp_path, monkeypatch):
    monkeypatch.setattr(bq_offline, "DbtRunner", FakeDbt)
    target = tmp_path / "full-build"
    stale = target / "compiled" / "peoplelake"
    for rel in ("models/core/dropped_model.sql", "tests/dropped_test.sql", "tests/reporting/renamed_test.sql"):
        (stale / rel).parent.mkdir(parents=True, exist_ok=True)
        # Stale SQL that would also fail the parse and the ORDER BY lint if it were read.
        (stale / rel).write_text("select a from t order by a (((")
    keep = target / "partial_parse.msgpack"
    keep.write_bytes(b"dbt's parse cache")

    report = bq_offline.compile_branch("full-build", target)

    assert (report.compiled_models, report.compiled_tests) == (2, 2)
    assert report.parse_errors == [] and report.order_violations == []
    assert sorted(str(p.relative_to(stale)) for p in stale.rglob("*.sql")) == sorted(WRITTEN)
    assert keep.read_bytes() == b"dbt's parse cache"  # only the compiled output is cleared


def test_the_same_target_compiled_twice_counts_the_same(tmp_path, monkeypatch):
    monkeypatch.setattr(bq_offline, "DbtRunner", FakeDbt)
    first = bq_offline.compile_branch("incremental", tmp_path / "incremental")
    second = bq_offline.compile_branch("incremental", tmp_path / "incremental")
    assert (first.compiled_models, first.compiled_tests) == (second.compiled_models, second.compiled_tests) == (2, 2)
