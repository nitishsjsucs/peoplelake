"""Offline BigQuery compile (SPEC 11.9): renders BigQuery SQL with no credentials and no connection.

Two compiles: the full-build branch (`pl_offline_compile`) and the incremental branch
(`pl_force_incremental_compile`: cursors, anti-joins, bucket filters). Every compiled model must parse
as BigQuery with sqlglot. This proves the SQL compiles and parses, not that it runs on BigQuery; the
BigQuery drill scenarios are the runtime proof.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import sqlglot

from ..warehouse.dbt_runner import DbtRunner
from .lint_sql import OrderViolation, lint_compiled

BRANCHES = {
    "full-build": {"pl_offline_compile": True},
    "incremental": {"pl_offline_compile": True, "pl_force_incremental_compile": True},
}


@dataclass
class CompileReport:
    branch: str
    compiled_models: int = 0
    compiled_tests: int = 0
    parse_errors: list[str] = field(default_factory=list)
    order_violations: list[OrderViolation] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.parse_errors and not self.order_violations


def compile_branch(branch: str, target_path: Path) -> CompileReport:
    """Compile one branch into `target_path` and count, parse and lint what this compile wrote. dbt never
    deletes compiled files of models or tests that no longer exist, so the compiled output of an earlier
    run in a reused target is removed first (dbt's parse cache next to it is kept)."""
    shutil.rmtree(target_path / "compiled", ignore_errors=True)
    dbt = DbtRunner(target="bq_offline", target_path=target_path)
    outcome = dbt.invoke(["compile", "--no-introspect", "--no-populate-cache", "--vars", json.dumps(BRANCHES[branch])])
    report = CompileReport(branch=branch)
    if not outcome.success:
        report.parse_errors.append(f"dbt compile failed: {outcome.exception}")
        return report
    compiled = target_path / "compiled" / "peoplelake"
    models_dir = compiled / "models"
    for path in sorted(compiled.rglob("*.sql")):
        is_model = path.is_relative_to(models_dir) and not any(p.endswith(".yml") for p in path.parts)
        if is_model:
            report.compiled_models += 1
        else:
            report.compiled_tests += 1
        try:
            sqlglot.parse(path.read_text(), read="bigquery")
        except sqlglot.errors.ParseError as exc:
            report.parse_errors.append(f"{path.relative_to(compiled)}: {str(exc).splitlines()[0]}")
    report.order_violations = lint_compiled(target_path / "compiled" / "peoplelake")
    return report


def manifest(target_path: Path) -> dict:
    """Parse with the offline BigQuery target and return the manifest (configs as BigQuery sees them)."""
    dbt = DbtRunner(target="bq_offline", target_path=target_path)
    outcome = dbt.invoke(["parse"])
    if not outcome.success:
        raise RuntimeError(f"dbt parse --target bq_offline failed: {outcome.exception}")
    return json.loads((target_path / "manifest.json").read_text())
