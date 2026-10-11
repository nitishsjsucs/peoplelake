"""`npm run prod:e2e` (SPEC 20.5): one live 60-minute delivery of the full profile to production, then
`prod verify` and the production freshness measurement from that delivery.

A second delivery of the same 100,000 event ids would only time duplicates that change no published row
and would double the lake and raw table, so this refuses to run while production already holds runs;
`peoplelake prod reset --confirm peoplelake` (runbook prod-reset.md) comes first.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from pathlib import Path

from ..evals.freshness import prod_freshness, prod_operator, write
from ..paths import repo_root
from ..sim.deliver import deliver
from .bootstrap_gcp import GcpConfig
from .verify import verify


def e2e(duration_minutes: float, *, quiesce_timeout_s: float = 3600.0) -> dict:
    op = prod_operator()
    status = op.status()
    if status.get("run_seq") not in (None, "0"):
        raise SystemExit("production already holds runs; reset first (docs/runbooks/prod-reset.md)")
    record = deliver(target="prod", profile="full", mode="live", duration_minutes=duration_minutes)
    deadline = time.monotonic() + quiesce_timeout_s
    while time.monotonic() < deadline:
        fresh = op.freshness("7d")["overall"]
        if fresh["events"] >= 100_000 and fresh["pending_events"] == 0 and op.status().get("active_run_id") is None:
            break
        time.sleep(30)
    verified = verify(GcpConfig.load(repo_root() / ".prod"))
    fresh = prod_freshness(record)
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    write(
        fresh,
        Path(repo_root() / "evals" / "results" / f"freshness-prod-full-{date}.json"),
        f"npm run prod:e2e (delivery {record['delivery_id']})",
    )
    return {"delivery": record, "verify_passed": verified["passed"], "p95_s": fresh["overall"]["p95_s"]}
