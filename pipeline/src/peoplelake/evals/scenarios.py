"""Scenario equivalence eval (SPEC 16.1): every scenario starts from empty state, delivers the same dataset
in chunk mode through the local stack, ends at quiescence, and must produce digests identical to the
reference digests (a straight load built with --full-refresh) on all 10 published models, with the oracle
matched and zero warn-level checks.

Engine and orchestration are labeled in every result: `--target local` runs DuckDB with the local
stand-ins; `--target prod-drill` keeps the local Worker, Workflows and lake but points the runner at
BigQuery `_drill` datasets.
"""

from __future__ import annotations

import json
import platform
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from ..auth.dev_tokens import AccessHeaders
from ..budget import BQ_MONTHLY_BYTES_CAP, BQ_TRANSFORM_RESERVE_BYTES
from ..generator import generate, get_profile
from ..paths import repo_root
from ..runner.client import WorkerClient
from ..sim.client import DeliveryStats, SourceClients
from ..sim.plan import SCENARIO_NAMES, Plan, build_plan
from ..stack import WORKER_URL, LocalStack
from ..warehouse.duckdb_wh import DuckDBWarehouse, connection


class EvalError(RuntimeError):
    pass


@dataclass
class Clients:
    operator: WorkerClient
    sources: SourceClients


def clients() -> Clients:
    keys = repo_root() / ".dev" / "keys"
    return Clients(
        operator=WorkerClient(WORKER_URL, AccessHeaders(local=True, identity="operator", keys_dir=keys)),
        sources=SourceClients(WORKER_URL, local=True, keys_dir=keys),
    )


def newest_seq(op: WorkerClient) -> int:
    runs = op.runs(1, "summary")
    return runs[0]["seq"] if runs else 0


def settle(op: WorkerClient, after_seq: int, *, timeout: float, request_after: float = 30.0) -> dict:
    """Wait for a run newer than `after_seq` to finish with nothing active or pending. The lake event of the
    forced roll normally starts it; if none appeared after `request_after` seconds, request one."""
    start = time.monotonic()
    requested = False
    while True:
        status = op.status()
        runs = op.runs(3, "summary")
        newest = runs[0] if runs else None
        if (
            newest is not None
            and newest["seq"] > after_seq
            and status["active_run_id"] is None
            and status["pending_mode"] is None
            and newest["status"] in ("committed", "failed")
        ):
            return newest
        waited = time.monotonic() - start
        if not requested and waited > request_after and (newest is None or newest["seq"] <= after_seq):
            op.request_run()
            requested = True
        if waited > timeout:
            raise EvalError(f"no run settled within {timeout} s after run {after_seq}")
        time.sleep(0.25)


def oracle_mismatches(duckdb_path: Path, profile: str) -> int:
    """Rows of the metrics mart that differ from the oracle, computed here independently of the dbt test."""
    with connection(duckdb_path) as con:
        return con.execute(
            """
            SELECT count(*) FROM peoplelake_core.metrics_workforce_monthly m
            FULL OUTER JOIN (SELECT * FROM peoplelake_ops.oracle_workforce_monthly WHERE profile = ?) o
              ON o.month = m.month AND o.department_id = m.department_id
            WHERE m.month IS NULL OR o.month IS NULL
               OR (m.headcount, m.fte, m.hires, m.rehires, m.departures, m.transfers_in, m.transfers_out,
                   m.offers_extended, m.offers_accepted, m.offers_declined, m.offer_acceptance_rate)
                  IS DISTINCT FROM
                  (o.headcount, o.fte, o.hires, o.rehires, o.departures, o.transfers_in, o.transfers_out,
                   o.offers_extended, o.offers_accepted, o.offers_declined, o.offer_acceptance_rate)
            """,
            [profile],
        ).fetchone()[0]


def raw_counts(duckdb_path: Path) -> dict:
    with connection(duckdb_path) as con:
        deliveries, unique = con.execute(
            "SELECT count(*), count(DISTINCT event_id) FROM peoplelake_raw.raw_event_deliveries"
        ).fetchone()
    return {
        "raw_deliveries": int(deliveries),
        "unique_events": int(unique),
        "duplicate_deliveries_in_raw": int(deliveries - unique),
    }


def ledger_summary(op: WorkerClient) -> dict:
    runs = op.all_runs("full")
    status = op.status()
    jobs = []
    for r in runs:
        jobs += op.run(r["run_id"])["jobs"]
    load_results = [
        j["result"] for j in jobs if j["kind"] == "load" and j["result"] and j["result"].get("status") == "succeeded"
    ]
    return {
        "runs": len(runs),
        "runs_committed": sum(r["status"] == "committed" for r in runs),
        "runs_failed": sum(r["status"] == "failed" for r in runs),
        "transforms_skipped": sum(bool(r["transform_skipped"]) for r in runs),
        "load_attempts": sum(r["load_attempts"] for r in runs),
        "transform_attempts": sum(r["transform_attempts"] for r in runs),
        "jobs_expired": sum(j["status"] == "expired" for j in jobs),
        "jobs_failed": sum(j["status"] == "failed" for j in jobs),
        "duplicate_results_ignored": int(status.get("duplicate_results") or 0),
        "lease_expirations": int(status.get("lease_expirations") or 0),
        "faults_fired_in_workflow": int(status.get("faults_fired") or 0),
        "duplicate_deliveries_skipped_by_loader": sum(r.get("duplicates_skipped") or 0 for r in runs),
        "snapshots_read": sum(lr["lake"]["snapshots_read"] for lr in load_results),
        "fallback_full_scans": sum(bool(lr["lake"]["fallback_full_scan"]) for lr in load_results),
        "_runs": runs,
    }


def latest_checks(runs: list[dict]) -> dict | None:
    for r in reversed(runs):
        if r["status"] == "committed" and r["checks"] and not r.get("options"):
            return r["checks"]
    return None


def rebuild_and_point_in_time(
    op: WorkerClient, stack: LocalStack, *, timeout: float, drill: DrillTarget | None = None
) -> dict:
    """S5: delete the warehouse and replay everything from the lake; then replay up to the middle run's
    snapshot into a scratch warehouse (its own DuckDB file) and require that run's recorded digests."""
    runs = [
        r
        for r in op.all_runs("full")
        if r["status"] == "committed" and r["digests"] and not r["transform_skipped"] and not r.get("options")
    ]
    if not runs:
        raise EvalError("S5 needs committed runs with digests")
    middle = runs[len(runs) // 2]
    stack.stop_runner()
    if drill:
        drill.warehouse().reset()  # empty the _drill datasets
    else:
        DuckDBWarehouse(stack.duckdb_path).reset()  # the runner was the only process holding the file
    stack.start_runner()
    before = newest_seq(op)
    op.replay()
    rebuild = settle(op, before, timeout=timeout, request_after=timeout)
    if drill:
        return {
            "rebuild_run": rebuild["run_id"],
            "rebuild_status": rebuild["status"],
            "point_in_time": "skipped on the BigQuery drill: it needs scratch datasets, which bootstrap does not create",
            "point_in_time_identical_to_recorded": True,
        }
    before = newest_seq(op)
    op.replay(to_snapshot=middle["to_snapshot"], dataset_suffix="pit")
    pit = settle(op, before, timeout=timeout, request_after=timeout)
    pit_full = op.run(pit["run_id"])["run"]
    return {
        "rebuild_run": rebuild["run_id"],
        "rebuild_status": rebuild["status"],
        "point_in_time_run": pit["run_id"],
        "point_in_time_of": middle["run_id"],
        "point_in_time_snapshot": middle["to_snapshot"],
        "point_in_time_identical_to_recorded": pit_full["digests"] == middle["digests"],
        "point_in_time_mismatched_models": sorted(
            m for m in middle["digests"] if (pit_full["digests"] or {}).get(m) != middle["digests"][m]
        ),
    }


def run_scenario(
    scenario: str,
    profile: str,
    n_chunks: int,
    reference: dict[str, str],
    *,
    workdir: Path,
    target: str = "local",
    chunk_timeout: float = 900.0,
) -> dict:
    drill = drill_target() if target == "prod-drill" else None
    ds = generate(get_profile(profile))
    plan: Plan = build_plan(scenario, ds, n_chunks)
    stack = LocalStack(
        mode="eval", profile=profile, state_dir=workdir / scenario, runner_env=drill.runner_env if drill else None
    )
    stack.reset_state()
    if drill:
        drill.warehouse().reset()
    started = time.monotonic()
    started_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    stack.up()
    extra: dict = {}
    try:
        c = clients()
        if plan.faults:
            c.operator.install_faults(plan.faults)
        stats = DeliveryStats()
        chunk_seconds = []
        for chunk in plan.chunks:
            t0 = time.monotonic()
            before = newest_seq(c.operator)
            for req in chunk:
                c.sources.deliver(req.source, req.envelopes, stats)
            c.operator.flush_landing()
            settle(c.operator, before, timeout=chunk_timeout)
            chunk_seconds.append(round(time.monotonic() - t0, 2))
        before = newest_seq(c.operator)
        c.operator.request_run()
        settle(c.operator, before, timeout=chunk_timeout, request_after=chunk_timeout)
        if scenario == "S5":
            extra = rebuild_and_point_in_time(c.operator, stack, timeout=chunk_timeout, drill=drill)
        ledger = ledger_summary(c.operator)
    finally:
        busy = stack.down()
    runs = ledger.pop("_runs")
    checks = latest_checks(runs) or {"error": {}, "warn": {}}
    ledger_digests = next(
        (r["digests"] for r in reversed(runs) if r["status"] == "committed" and r["digests"] and not r.get("options")),
        {},
    )
    if drill:
        bq = drill.warehouse()
        file_digests = bq.digests()
        mismatches = bq.oracle_mismatches(profile)
        raw = bq.raw_counts()
    else:
        file_digests = DuckDBWarehouse(stack.duckdb_path).digests()  # opened only after stack down (ADR 0008)
        mismatches = oracle_mismatches(stack.duckdb_path, profile)
        raw = raw_counts(stack.duckdb_path)
    identical = {m: file_digests.get(m) == reference[m] and ledger_digests.get(m) == reference[m] for m in reference}
    warn_total = sum(checks["warn"].values())
    error_total = sum(checks["error"].values())
    passed = all(identical.values()) and mismatches == 0 and warn_total == 0 and error_total == 0 and not busy
    if scenario == "S5":
        passed = passed and extra.get("point_in_time_identical_to_recorded", False)
    return {
        "scenario": scenario,
        "name": SCENARIO_NAMES[scenario],
        "profile": profile,
        "chunks": n_chunks,
        "started_at": started_at,
        "duration_s": round(time.monotonic() - started, 1),
        "passed": passed,
        "identical_to_reference": identical,
        "digests": file_digests,
        "oracle_rows_mismatched": mismatches,
        "warn_checks_at_quiescence": checks["warn"],
        "error_checks_at_quiescence": checks["error"],
        "ports_busy_after_stack_down": busy,
        "planned": plan.planned,
        "faults": plan.faults,
        "engine": "bigquery" if drill else "duckdb",
        "observed": {"deliveries_sent": stats.records, "requests_sent": stats.requests, **raw, **ledger},
        "chunk_seconds": chunk_seconds,
        **({"rebuild": extra} if extra else {}),
    }


def drill_scenario_estimate_bytes(chunks: int) -> int:
    """BigQuery bytes one drill scenario bills: about one transform per chunk, plus the quiescence run and
    S5's rebuild, at about 3 GB each (SPEC 29.5: the 10 MB minimum per referenced table dominates)."""
    return (chunks + 2) * BQ_TRANSFORM_RESERVE_BYTES


def run_scenarios(
    wanted: list[str],
    run_one: Callable[[str], dict],
    *,
    month_billed: Callable[[], int] | None = None,
    chunks: int = 10,
    cap: int = BQ_MONTHLY_BYTES_CAP,
) -> tuple[list[dict], list[str], int | None]:
    """Run scenarios in order. With `month_billed` (the BigQuery drill), stop before a scenario whose
    estimate would take this month's billed bytes past the monthly guard; returns the results, the
    scenarios left for next month (resume with --scenarios) and the billed bytes that stopped it."""
    results: list[dict] = []
    for i, scenario in enumerate(wanted):
        if month_billed is not None:
            billed = month_billed()
            if billed + drill_scenario_estimate_bytes(chunks) > cap:
                return results, wanted[i:], billed
        results.append(run_one(scenario))
    return results, [], None


@dataclass
class DrillTarget:
    """`--target prod-drill`: local Worker, Workflows and lake stand-ins; the runner writes BigQuery `_drill`
    datasets as peoplelake-runner (the operator's ADC impersonating it)."""

    project: str
    location: str
    runner_sa: str
    runner_env: dict

    def month_billed(self) -> int:
        """Bytes billed this month by this repo's jobs (queried as the operator, capped). The total also goes
        to the production Coordinator as the floor of its monthly guard: the drill bills through the local
        Worker, so production's ledger would otherwise never see it."""
        import sys

        from ..prod.doctor_gcp import month_bytes_billed, report_month_to_production
        from ..warehouse.bigquery_wh import bigquery_client

        billed = month_bytes_billed(bigquery_client(self.project, self.location))
        try:
            report_month_to_production(billed)
        except Exception as exc:  # noqa: BLE001 - the drill guard itself does not depend on production
            print(f"warning: could not report {billed} bytes to the production Worker: {exc}", file=sys.stderr)
        return billed

    def warehouse(self):
        from ..warehouse.bigquery_wh import BigQueryWarehouse, bigquery_client

        return BigQueryWarehouse(
            bigquery_client(self.project, self.location, self.runner_sa),
            self.project,
            location=self.location,
            suffix="drill",
        )


def drill_target() -> DrillTarget:
    gcp_file = repo_root() / ".prod" / "gcp.json"
    if not gcp_file.exists():
        raise EvalError("--target prod-drill needs `peoplelake prod bootstrap-gcp` first (.prod/gcp.json)")
    gcp = json.loads(gcp_file.read_text())
    runner_sa = gcp["service_accounts"]["runner"]
    env = {
        "PL_TARGET": "prod-drill",
        "PL_GCP_PROJECT": gcp["project"],
        "PL_BQ_LOCATION": gcp["bq_location"],
        "PL_RUNNER_SA": runner_sa,
        "PL_DATASET_SUFFIX": "drill",
        "PL_PT_COMPENSATION": gcp["policy_tags"].get("compensation", ""),
        "PL_PT_PERFORMANCE": gcp["policy_tags"].get("performance", ""),
    }
    return DrillTarget(gcp["project"], gcp["bq_location"], runner_sa, env)


def scenarios_report(results: list[dict], *, profile: str, reference: dict, command: str) -> dict:
    engine = results[0].get("engine", "duckdb") if results else "duckdb"
    return {
        "kind": "scenario-equivalence",
        "command": command,
        "date": datetime.now(UTC).strftime("%Y-%m-%d"),
        "profile": profile,
        "engine": engine,
        "orchestration": "local (wrangler dev / Miniflare Workflows)",
        "lake": "LandingRoller landing (same code as production) + pyiceberg SqlCatalog (local catalog stand-in)",
        "runner": "peoplelake runner poll (local process)",
        "machine": f"{platform.system()} {platform.machine()}",
        "reference_digests": reference,
        "passed": all(r["passed"] for r in results) and len(results) > 0,
        "scenarios": results,
    }


def results_name(profile: str, engine: str, date: str, scenarios: list[str]) -> str:
    """`scenarios-<profile>-<engine>-<date>[-<ids>].json`: the engine comes from the report, so a BigQuery
    drill never overwrites a DuckDB result and `doctor-gcp` finds it as go-live evidence."""
    from ..sim.plan import SCENARIOS

    suffix = "" if sorted(scenarios) == sorted(SCENARIOS) else "-" + "-".join(scenarios)
    return f"scenarios-{profile}-{engine}-{date}{suffix}.json"


def write_report(report: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
