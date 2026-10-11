"""Freshness eval (SPEC 16.2): deliver a profile at a constant rate through the local stack in live mode
(60 s landing rolls, the cron ticker, single-flight runs) and measure, per unique event, the
commit time of the run that published it minus its first receipt by the Worker.

Numbers come from the Coordinator ledger (10 s buckets of first receipt against `published_at`, so each
value is conservative by up to 10 s) and are cross-checked against the `ops_event_freshness` histograms
the runner returns with every transform. The eval never opens the warehouse file while the stack is up
(ADR 0008). Local results describe the local stack only; the 15-minute figure is a target that is
reported, never asserted.
"""

from __future__ import annotations

import json
import platform
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from ..generator import generate, get_profile
from ..sim.client import DeliveryStats
from ..sim.deliver import send_live
from ..sim.plan import LOCAL_TICK_SECONDS
from ..stack import LocalStack
from ..warehouse.direct import canonical_order, envelopes_from_dataset
from .scenarios import EvalError, clients


def weighted_percentile(values: list[tuple[float, int]], p: float) -> float | None:
    """Nearest rank on weighted values, the same rule as src/worker/api/freshness.ts."""
    total = sum(w for _, w in values)
    if total == 0:
        return None
    target = p * total
    cumulative = 0
    for v, w in sorted(values):
        cumulative += w
        if cumulative >= target:
            return v
    return sorted(values)[-1][0]


def summarize(values: list[tuple[float, int]]) -> dict:
    events = sum(w for _, w in values)
    within = sum(w for v, w in values if v <= 900)
    return {
        "events": events,
        "p50_s": weighted_percentile(values, 0.5),
        "p90_s": weighted_percentile(values, 0.9),
        "p95_s": weighted_percentile(values, 0.95),
        "p99_s": weighted_percentile(values, 0.99),
        "max_s": max((v for v, _ in values), default=None),
        "share_within_15m": round(within / events, 6) if events else None,
    }


def _deliver_paced(sources, items: list[tuple[str, dict]], rate: float, *, tick: float = LOCAL_TICK_SECONDS) -> dict:
    start = time.monotonic()
    stats = DeliveryStats()
    send_live(sources, items, len(items) / rate, tick, stats)
    return {
        "delivered": stats.records,
        "requests": stats.requests,
        "seconds": round(time.monotonic() - start, 1),
        "tick_seconds": tick,
    }


def run_freshness(
    profile: str,
    duration_minutes: float,
    *,
    workdir: Path,
    rate: float | None = None,
    tick_seconds: float = LOCAL_TICK_SECONDS,
    quiesce_timeout: float = 1800.0,
) -> dict:
    ds = generate(get_profile(profile))
    items = canonical_order(envelopes_from_dataset(ds))
    rate = rate or len(items) / (duration_minutes * 60)
    stack = LocalStack(mode="live", profile=profile, state_dir=workdir / "freshness")
    stack.reset_state()
    started_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    stack.up()
    try:
        c = clients()
        delivery_start = time.time()
        delivery = _deliver_paced(c.sources, items, rate, tick=tick_seconds)
        deadline = time.monotonic() + quiesce_timeout
        while True:
            fresh = c.operator.freshness("7d")
            status = c.operator.status()
            if (
                fresh["overall"]["events"] >= len(items)
                and fresh["overall"]["pending_events"] == 0
                and status["active_run_id"] is None
            ):
                break
            if time.monotonic() > deadline:
                raise EvalError(f"not quiescent after {quiesce_timeout} s: {fresh['overall']}")
            time.sleep(5)
        runs = sorted(c.operator.runs(5000, "full"), key=lambda r: r["seq"])
        jobs = {r["run_id"]: c.operator.run(r["run_id"])["jobs"] for r in runs}
    finally:
        busy = stack.down()

    published = {r["run_id"]: r for r in runs}
    values: list[tuple[float, int]] = []
    late_values: list[tuple[float, int]] = []
    wait_part: list[tuple[float, int]] = []
    run_part: list[tuple[float, int]] = []
    ledger_hist: Counter = Counter()
    for b in fresh["buckets"]:
        if b["published_at"] is None:
            continue
        v = max(0.0, round(b["published_at"] / 1000) - b["bucket_start_s"])
        values.append((v, b["events"]))
        ledger_hist[b["bucket_start_s"]] += b["events"]
        if b["bucket_start_s"] >= delivery_start + 300:
            late_values.append((v, b["events"]))
        run = published.get(b["published_by"])
        if run and run["started_at"]:
            wait_part.append((max(0.0, round(run["started_at"] / 1000) - b["bucket_start_s"]), b["events"]))
            run_part.append((round((b["published_at"] - run["started_at"]) / 1000), b["events"]))

    ops_hist: Counter = Counter()
    for job_list in jobs.values():
        for j in job_list:
            if j["kind"] == "transform" and j["status"] == "succeeded" and j["result"]:
                for bucket, n in j["result"].get("ops_freshness_histogram_10s", []):
                    ops_hist[bucket] += n
    mismatched_buckets = sorted(
        set(ledger_hist) ^ set(ops_hist) | {k for k in ledger_hist if ledger_hist[k] != ops_hist.get(k)}
    )

    durations = [((r["finished_at"] or 0) - (r["started_at"] or 0)) / 1000 for r in runs if r["status"] == "committed"]
    stages: dict[str, list[tuple[float, int]]] = {"dispatch_s": [], "load_s": [], "transform_s": [], "commit_s": []}
    for r in runs:
        js = {(j["kind"], j["status"]): j for j in jobs[r["run_id"]]}
        load = js.get(("load", "succeeded"))
        transform = js.get(("transform", "succeeded"))
        if load:
            stages["dispatch_s"].append(((load["claimed_at"] - load["created_at"]) / 1000, 1))
            stages["load_s"].append(((load["finished_at"] - load["claimed_at"]) / 1000, 1))
        if transform:
            stages["transform_s"].append(((transform["finished_at"] - transform["claimed_at"]) / 1000, 1))
        last = transform or load
        if last and r["published_at"]:
            stages["commit_s"].append(((r["published_at"] - last["finished_at"]) / 1000, 1))
    return {
        "kind": "freshness",
        "target": "local",
        "engine": "duckdb",
        "profile": profile,
        "method": "ledger histograms of first receipt (10 s buckets) against the publishing run's commit time",
        "stand_ins": "pyiceberg SqlCatalog, local runner process, ticker for cron (the LandingRoller landing with 60 s rolls is the production code)",
        "machine": f"{platform.system()} {platform.machine()}",
        "started_at": started_at,
        "events": len(items),
        "duration_minutes": duration_minutes,
        "rate_events_per_s": round(rate, 3),
        "delivery": delivery,
        "overall": summarize(values),
        "excluding_first_5_minutes": summarize(late_values),
        "components": {
            "receive_to_run_start": summarize(wait_part),
            "run_start_to_commit": summarize(run_part),
            "stages_per_run": {k: summarize(v) for k, v in stages.items()},
        },
        "runs": len(runs),
        "runs_committed": sum(r["status"] == "committed" for r in runs),
        "transforms_skipped": sum(bool(r["transform_skipped"]) for r in runs),
        "run_duration_s": {
            "p50": weighted_percentile([(d, 1) for d in durations], 0.5),
            "p95": weighted_percentile([(d, 1) for d in durations], 0.95),
        },
        "cross_check_ops_histogram": {
            "ledger_events": sum(ledger_hist.values()),
            "ops_events": sum(ops_hist.values()),
            "mismatched_10s_buckets": len(mismatched_buckets),
            "agrees": sum(ledger_hist.values()) == sum(ops_hist.values()) and not mismatched_buckets,
        },
        "ports_busy_after_stack_down": busy,
        "target_15_minutes_p95_met": (summarize(values)["p95_s"] or 0) <= 900,
    }


def write(report: dict, out: Path, command: str) -> None:
    report = {"command": command, "date": datetime.now(UTC).strftime("%Y-%m-%d"), **report}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


def prod_operator():
    """Operator client for the production Worker (the pl-doctor service token)."""
    from ..auth.dev_tokens import AccessHeaders
    from ..envfile import read_env_file
    from ..paths import repo_root
    from ..runner.client import WorkerClient

    prod = repo_root() / ".prod"
    secrets = read_env_file(prod / "secrets.env")
    state = json.loads((prod / "state.json").read_text())
    headers = AccessHeaders(
        local=False,
        client_id=secrets.get("PL_CF_DOCTOR_CLIENT_ID"),
        client_secret=secrets.get("PL_CF_DOCTOR_CLIENT_SECRET"),
    )
    return WorkerClient(f"https://peoplelake.{state['workers_subdomain']}.workers.dev", headers)


def prod_freshness(delivery: dict) -> dict:
    """Production p50/p95 from the single live `prod:e2e` delivery; it delivers nothing itself."""
    op = prod_operator()
    start = datetime.fromisoformat(delivery["started_at"].replace("Z", "+00:00")).timestamp()
    fresh = op.freshness("7d")
    buckets = [b for b in fresh["buckets"] if b["bucket_start_s"] >= start - 10]
    values = [
        (max(0.0, round(b["published_at"] / 1000) - b["bucket_start_s"]), b["events"])
        for b in buckets
        if b["published_at"]
    ]
    late = [
        (v, w)
        for (v, w), b in zip(values, [b for b in buckets if b["published_at"]], strict=True)
        if b["bucket_start_s"] >= start + 300
    ]
    runs = [r for r in op.runs(5000, "summary") if (r["started_at"] or 0) / 1000 >= start - 60]
    return {
        "kind": "freshness",
        "target": "prod",
        "engine": "bigquery",
        "profile": delivery["profile"],
        "method": "single-live-delivery",
        "delivery_id": delivery["delivery_id"],
        "stand_ins": "none (LandingRoller on R2, Basin Catalog, Cloudflare Workflows, Cloud Run Job, BigQuery)",
        "events": delivery["records"],
        "duration_minutes": delivery["duration_minutes"],
        "overall": summarize(values),
        "excluding_first_5_minutes": summarize(late),
        "pending_events": sum(b["events"] for b in buckets if not b["published_at"]),
        "runs": len(runs),
        "runs_committed": sum(r["status"] == "committed" for r in runs),
        "target_15_minutes_p95_met": (summarize(values)["p95_s"] or 0) <= 900,
    }
