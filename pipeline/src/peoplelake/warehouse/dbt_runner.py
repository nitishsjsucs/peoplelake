"""In-process dbt (ADR 0008): the runner process owns the DuckDB file, so dbt runs inside it.

Profile, profile name and dataset suffix come from environment variables fixed for the process
(`PL_PROFILE`, `PL_DATASET_SUFFIX`, `PL_DUCKDB_PATH`); faults come from `PL_FAULT_FAIL_MODEL`. No
per-run `--vars`, because changed vars force a full re-parse.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..paths import warehouse_dir

UNIT_TEST_EXCLUDE = ["--exclude-resource-type", "unit_test"]


@dataclass
class DbtOutcome:
    command: str
    success: bool
    elapsed_ms: int
    models_ok: int = 0
    models_error: int = 0
    tests_pass: int = 0
    tests_warn: int = 0
    tests_error: int = 0
    skipped: int = 0
    checks_error: dict[str, int] = field(default_factory=dict)
    checks_warn: dict[str, int] = field(default_factory=dict)
    failed_nodes: list[str] = field(default_factory=list)
    bytes_billed: int = 0
    exception: str | None = None


@contextmanager
def env_overrides(values: dict[str, str | None]) -> Iterator[None]:
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _test_name(unique_id: str) -> str:
    # test.peoplelake.recon_metrics_vs_oracle  or  test.peoplelake.not_null_dim_job_job_code.abc123
    parts = unique_id.split(".")
    return parts[2] if len(parts) > 2 else unique_id


def test_severities(manifest: dict[str, Any]) -> dict[str, str]:
    """unique_id -> 'error' | 'warn' for every data test in the manifest."""
    out = {}
    for uid, node in manifest.get("nodes", {}).items():
        if node.get("resource_type") == "test":
            out[uid] = str(node.get("config", {}).get("severity", "error")).lower()
    return out


def summarize(
    command: str,
    run_results: dict[str, Any],
    success: bool,
    elapsed_ms: int,
    severities: dict[str, str] | None = None,
) -> DbtOutcome:
    out = DbtOutcome(command=command, success=success, elapsed_ms=elapsed_ms)
    severities = severities or {}
    for r in run_results.get("results", []):
        uid: str = r.get("unique_id", "")
        status: str = r.get("status", "")
        failures = r.get("failures") or 0
        adapter = r.get("adapter_response") or {}
        out.bytes_billed += int(adapter.get("bytes_billed") or 0)
        if uid.startswith("model.") or uid.startswith("seed.") or uid.startswith("snapshot."):
            if status == "success":
                out.models_ok += 1
            elif status == "skipped":
                out.skipped += 1
            else:
                out.models_error += 1
                out.failed_nodes.append(uid)
        elif uid.startswith("test.") or uid.startswith("unit_test."):
            name = _test_name(uid)
            if status == "pass":
                out.tests_pass += 1
                bucket = out.checks_warn if severities.get(uid) == "warn" else out.checks_error
                bucket.setdefault(name, 0)
            elif status == "warn":
                out.tests_warn += 1
                out.checks_warn[name] = int(failures)
            elif status == "skipped":
                out.skipped += 1
            else:
                out.tests_error += 1
                out.checks_error[name] = int(failures) if failures else 1
                out.failed_nodes.append(uid)
    return out


class DbtRunner:
    def __init__(
        self,
        *,
        target: str = "local",
        project_dir: Path | None = None,
        profiles_dir: Path | None = None,
        target_path: Path | None = None,
    ) -> None:
        self.project_dir = project_dir or warehouse_dir()
        self.profiles_dir = profiles_dir or self.project_dir
        self.target = target
        self.target_path = target_path or self.project_dir / "target"

    def invoke(self, args: list[str], *, fail_model: str | None = None) -> DbtOutcome:
        from dbt.cli.main import dbtRunner

        command = args[0]
        argv = [
            *args,
            "--project-dir",
            str(self.project_dir),
            "--profiles-dir",
            str(self.profiles_dir),
            "--target",
            self.target,
            "--target-path",
            str(self.target_path),
            "--log-path",
            str(self.target_path / "logs"),
            "--quiet",
        ]
        started = time.monotonic()
        with env_overrides({"PL_FAULT_FAIL_MODEL": fail_model, "TZ": "UTC"}):
            result = dbtRunner().invoke(argv)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        run_results_path = self.target_path / "run_results.json"
        run_results: dict[str, Any] = {}
        severities: dict[str, str] = {}
        if run_results_path.exists() and command in ("build", "run", "test", "seed"):
            run_results = json.loads(run_results_path.read_text())
            manifest_path = self.target_path / "manifest.json"
            if manifest_path.exists():
                severities = test_severities(json.loads(manifest_path.read_text()))
        outcome = summarize(command, run_results, bool(result.success), elapsed_ms, severities)
        if result.exception is not None:
            outcome.exception = str(result.exception)
        return outcome

    def seed(self, *, full_refresh: bool = False) -> DbtOutcome:
        return self.invoke(["seed", *(["--full-refresh"] if full_refresh else [])])

    def build(
        self,
        *,
        full_refresh: bool = False,
        unit_tests: bool = False,
        select: list[str] | None = None,
        exclude: list[str] | None = None,
        fail_model: str | None = None,
    ) -> DbtOutcome:
        args = ["build"]
        if full_refresh:
            args.append("--full-refresh")
        if not unit_tests:
            args += UNIT_TEST_EXCLUDE
        if select:
            args += ["--select", *select]
        if exclude:
            args += ["--exclude", *exclude]
        return self.invoke(args, fail_model=fail_model)

    def run_empty(self) -> DbtOutcome:
        """Create every relation with no rows, so unit tests can introspect columns (SPEC 11.5)."""
        return self.invoke(["run", "--empty"])
