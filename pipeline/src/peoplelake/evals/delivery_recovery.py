"""Delivery recovery eval (SPEC 29.4.1 item 11): the baseline delivery through a proxy that fails requests.

The source clients reach `wrangler dev` through a tiny HTTP proxy on a Unix socket (so no TCP port beyond
the stack's), which fails chosen ingest requests on purpose, by their order through the proxy (retries
included). Five kinds of failure: two the Worker never sees (a dropped connection, a 500 like the one
wrangler's proxy answered in the final gate), a refusal (503 `landing_backpressure` with Retry-After), and
two after the Worker landed the batch (the answer lost, or replaced by a 500), which the source must retry
although the events are already in the lake.

The run passes when every batch is accepted, the published digests equal the reference, the oracle
matches, no warn or error check fires, every event is in `stg_events` exactly once, the duplicate
deliveries in the raw table are exactly the records of the requests the proxy forwarded and then failed,
the freshness ledger holds each event once, and the client's `possible_duplicate_deliveries` bounds the
duplicates.
"""

from __future__ import annotations

import json
import logging
import platform
import shutil
import socketserver
import tempfile
import threading
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import httpx

from ..generator import generate, get_profile
from ..runner.client import WorkerClient
from ..sim.plan import build_plan
from ..sim.retry import RetryPolicy

log = logging.getLogger("peoplelake.evals.delivery_recovery")

FAULT_KINDS = {
    "drop": "the proxy closes the connection without forwarding the request (the Worker never sees it)",
    "error_500": "the proxy answers 500 `Error: Network connection lost.` without forwarding",
    "backpressure_503": "the proxy answers 503 `landing_backpressure` (accepted 0) with Retry-After: 1",
    "lost_answer": "the Worker lands the batch, then the proxy closes the connection without answering",
    "error_500_after_landing": "the Worker lands the batch, then the proxy answers 500 instead of its 202",
}
LANDS = {"lost_answer", "error_500_after_landing"}

# Bursts at a share of the planned requests; a burst's faults hit consecutive requests through the proxy,
# so one batch fails several times in a row before it is accepted.
DEFAULT_FAULTS: list[tuple[float, list[str]]] = [
    (0.02, ["drop", "error_500"]),
    (0.10, ["lost_answer"]),
    (0.20, ["error_500_after_landing", "backpressure_503"]),
    (0.35, ["error_500", "error_500", "error_500"]),
    (0.50, ["backpressure_503"]),
    (0.60, ["lost_answer", "lost_answer"]),
    (0.75, ["drop"]),
    (0.85, ["error_500_after_landing"]),
    (0.95, ["error_500"]),
]

HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"}


def schedule_for(planned_requests: int, plan: list[tuple[float, list[str]]]) -> dict[int, str]:
    """Ingest request ordinal (1-based, through the proxy, retries included) to the fault it gets."""
    schedule: dict[int, str] = {}
    for share, burst in plan:
        start = max(1, round(share * planned_requests))
        for i, kind in enumerate(burst):
            if kind not in FAULT_KINDS:
                raise ValueError(f"unknown fault {kind!r}")
            if start + i in schedule:
                raise ValueError(f"fault bursts overlap at request {start + i}")
            schedule[start + i] = kind
    return schedule


@dataclass(frozen=True)
class InjectedFault:
    ordinal: int
    kind: str
    source: str
    records: int
    landed: bool


@dataclass
class ProxyLedger:
    ingest_requests: int = 0
    forwarded: int = 0
    faults: list[InjectedFault] = field(default_factory=list)

    def landed_then_failed_records(self) -> int:
        return sum(f.records for f in self.faults if f.landed)


class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, proxy: FaultProxy) -> None:
        self.proxy = proxy
        super().__init__(path, _Handler)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 300
    server: _Server

    def log_message(self, format: str, *args) -> None:
        pass

    def address_string(self) -> str:
        return "unix"

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def _answer(self, status: int, body: bytes, headers: dict[str, str]) -> None:
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self, body: bytes) -> httpx.Response:
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        return self.server.proxy.upstream.request(self.command, self.path, headers=headers, content=body)

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        proxy = self.server.proxy
        ordinal, kind = (
            proxy._next(self.path) if self.command == "POST" and self.path.startswith("/v1/ingest/") else (0, None)
        )
        if kind in ("drop", "error_500", "backpressure_503"):
            proxy._record(ordinal, kind, self.path, body, landed=False)
            if kind == "drop":
                self.close_connection = True
            elif kind == "error_500":
                self._answer(500, b"Error: Network connection lost.", {"Content-Type": "text/plain"})
            else:
                refused = json.dumps({"error": "landing_backpressure", "accepted": 0}).encode()
                self._answer(503, refused, {"Content-Type": "application/json", "Retry-After": "1"})
            return
        res = self._forward(body)
        if kind in LANDS:
            proxy._record(ordinal, kind, self.path, body, landed=res.status_code == 202)
            if kind == "lost_answer":
                self.close_connection = True
            else:
                self._answer(500, b"Error: Network connection lost.", {"Content-Type": "text/plain"})
            return
        passed = {k: v for k, v in res.headers.items() if k.lower() in ("content-type", "retry-after")}
        self._answer(res.status_code, res.content, passed)


class FaultProxy:
    """An HTTP proxy on a Unix socket in a fresh temporary directory (removed on stop)."""

    def __init__(
        self, upstream_url: str, schedule: dict[int, str], *, upstream_transport: httpx.BaseTransport | None = None
    ) -> None:
        self.schedule = dict(schedule)
        self.ledger = ProxyLedger()
        self.upstream = httpx.Client(base_url=upstream_url, timeout=60.0, transport=upstream_transport)
        self._lock = threading.Lock()
        self._dir: Path | None = None
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    @property
    def socket_path(self) -> str:
        assert self._dir is not None, "start the proxy first"
        return str(self._dir / "proxy.sock")

    def start(self) -> FaultProxy:
        self._dir = Path(tempfile.mkdtemp(prefix="pl-proxy-"))  # short: a Unix socket path has ~104 bytes
        self._server = _Server(self.socket_path, self)
        self._thread = threading.Thread(target=self._server.serve_forever, name="fault-proxy", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        self.upstream.close()
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None

    def client_transport(self) -> httpx.HTTPTransport:
        """The transport the source clients use: every request goes through the proxy's socket."""
        return httpx.HTTPTransport(uds=self.socket_path)

    def _next(self, path: str) -> tuple[int, str | None]:
        with self._lock:
            self.ledger.ingest_requests += 1
            ordinal = self.ledger.ingest_requests
            return ordinal, self.schedule.get(ordinal)

    def _record(self, ordinal: int, kind: str, path: str, body: bytes, *, landed: bool) -> None:
        records = len(next(iter(json.loads(body).values())))
        source = path.rsplit("/", 1)[-1]
        with self._lock:
            self.ledger.faults.append(InjectedFault(ordinal, kind, source, records, landed))
        log.info("proxy: ingest request %d (%s, %d records): %s", ordinal, source, records, kind)


def stg_counts(duckdb_path: Path) -> dict:
    from ..warehouse.duckdb_wh import connection

    with connection(duckdb_path) as con:
        rows, unique = con.execute(
            "SELECT count(*), count(DISTINCT event_id) FROM peoplelake_staging.stg_events"
        ).fetchone()
    return {"stg_events_rows": int(rows), "stg_events_unique": int(unique)}


def run_delivery_recovery(
    profile: str,
    n_chunks: int,
    reference: dict[str, str],
    *,
    workdir: Path,
    faults: list[tuple[float, list[str]]] | None = None,
) -> dict:
    """The baseline scenario (B) through the fault proxy, with every check of the module docstring."""
    from ..stack import WORKER_URL, LocalStack
    from .scenarios import run_scenario

    plan = faults or DEFAULT_FAULTS
    expected_events = get_profile(profile).total_events
    planned_requests = sum(len(chunk) for chunk in build_plan("B", generate(get_profile(profile)), n_chunks).chunks)
    schedule = schedule_for(planned_requests, plan)
    proxy = FaultProxy(WORKER_URL, schedule).start()
    started = time.monotonic()

    def freshness_ledger(op: WorkerClient) -> dict:
        overall = op.freshness("7d")["overall"]
        return {"freshness_ledger_events": overall["events"], "freshness_ledger_pending": overall["pending_events"]}

    try:
        result = run_scenario(
            "B",
            profile,
            n_chunks,
            reference,
            workdir=workdir,
            source_transport=proxy.client_transport(),
            observe=freshness_ledger,
        )
    finally:
        proxy.stop()
    stg = stg_counts(LocalStack(state_dir=workdir / "B").duckdb_path)  # opened after stack down (ADR 0008)
    obs = result["observed"]
    ledger = proxy.ledger
    landed_twice = ledger.landed_then_failed_records()
    checks = {
        "scenario_checks_pass": result["passed"],
        "every_batch_accepted": obs["deliveries_sent"] == expected_events,
        "every_fault_fired": len(ledger.faults) == len(schedule),
        "one_retry_per_fault": obs["retries"] == len(ledger.faults),
        "stg_events_hold_each_event_once": stg["stg_events_rows"] == stg["stg_events_unique"] == expected_events,
        "raw_duplicates_equal_landed_then_failed": obs["duplicate_deliveries_in_raw"] == landed_twice,
        "freshness_ledger_counts_each_event_once": obs["freshness_ledger_events"] == expected_events
        and obs["freshness_ledger_pending"] == 0,
        "client_bound_holds": landed_twice <= obs["possible_duplicate_deliveries"],
    }
    return {
        "kind": "delivery-recovery",
        "profile": profile,
        "engine": result["engine"],
        "chunks": n_chunks,
        "orchestration": "local (wrangler dev / Miniflare Workflows)",
        "proxy": (
            "HTTP proxy on a Unix socket between the source clients and wrangler dev, failing chosen ingest "
            "requests (pipeline/src/peoplelake/evals/delivery_recovery.py)"
        ),
        "fault_kinds": FAULT_KINDS,
        "retry_policy": asdict(RetryPolicy()),
        "machine": f"{platform.system()} {platform.machine()}",
        "started_at": result["started_at"],
        "duration_s": round(time.monotonic() - started, 1),
        "planned_requests": planned_requests,
        "proxy_ingest_requests": ledger.ingest_requests,
        "faults": [asdict(f) for f in ledger.faults],
        "faults_by_kind": dict(Counter(f.kind for f in ledger.faults)),
        "landed_then_failed_records": landed_twice,
        "delivery": {
            k: obs[k]
            for k in (
                "deliveries_sent",
                "requests_sent",
                "attempts",
                "retries",
                "retry_reasons",
                "possible_duplicate_deliveries",
            )
        },
        "warehouse": {
            "raw_deliveries": obs["raw_deliveries"],
            "unique_events": obs["unique_events"],
            "duplicate_deliveries_in_raw": obs["duplicate_deliveries_in_raw"],
            **stg,
            "freshness_ledger_events": obs["freshness_ledger_events"],
            "runs": obs["runs"],
            "runs_committed": obs["runs_committed"],
        },
        "identical_to_reference": result["identical_to_reference"],
        "oracle_rows_mismatched": result["oracle_rows_mismatched"],
        "warn_checks_at_quiescence": result["warn_checks_at_quiescence"],
        "error_checks_at_quiescence": result["error_checks_at_quiescence"],
        "ports_busy_after_stack_down": result["ports_busy_after_stack_down"],
        "checks": checks,
        "passed": all(checks.values()),
    }


def write(report: dict, out: Path, command: str) -> None:
    report = {"command": command, "date": datetime.now(UTC).strftime("%Y-%m-%d"), **report}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
