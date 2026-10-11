"""Local stack manager (SPEC 10.4): wrangler dev on 127.0.0.1:8791 (inspector 9241), the runner loop and,
in live mode, a ticker that calls the local scheduled handler every 60 s. Every process runs in its own
process group and is killed (SIGTERM, then SIGKILL after 5 s) on `stack down`, on exit and on signals.
While the stack is up, only the runner process opens the DuckDB file (ADR 0008).
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .paths import data_dir, repo_root

WRANGLER_PORT = 8791
INSPECTOR_PORT = 9241
LLAMA_PORT = 8150
PORTS = (WRANGLER_PORT, INSPECTOR_PORT, LLAMA_PORT)
WORKER_URL = f"http://127.0.0.1:{WRANGLER_PORT}"


class StackError(RuntimeError):
    pass


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex((host, port)) == 0


def ports_busy(ports: tuple[int, ...] = PORTS) -> list[int]:
    return [p for p in ports if port_in_use(p)]


@dataclass
class ManagedProcess:
    name: str
    argv: list[str]
    log_path: Path
    env: dict[str, str] = field(default_factory=dict)
    cwd: Path | None = None
    proc: subprocess.Popen | None = None

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(self.log_path, "ab")  # noqa: SIM115 - handed to the child process
        self.proc = subprocess.Popen(
            self.argv,
            cwd=self.cwd,
            env={**os.environ, **self.env},
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # own process group
        )

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc else None

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


def kill_group(pgid: int, grace: float = 5.0) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.1)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGKILL)


def wait_ports_free(ports: tuple[int, ...] = PORTS, timeout: float = 10.0) -> list[int]:
    deadline = time.monotonic() + timeout
    busy = ports_busy(ports)
    while busy and time.monotonic() < deadline:
        time.sleep(0.2)
        busy = ports_busy(ports)
    return busy


class LocalStack:
    """wrangler dev + runner (+ ticker). Use as a context manager or via `peoplelake stack up/down`."""

    def __init__(
        self,
        *,
        state_dir: Path | None = None,
        mode: str = "eval",
        profile: str = "small",
        runner: bool = True,
        ticker: bool | None = None,
        lease_seconds: int | None = None,
        claim_timeout_seconds: int | None = None,
        extra_vars: dict[str, str] | None = None,
    ) -> None:
        self.root = repo_root()
        self.state_dir = state_dir or data_dir() / "stack"
        self.mode = mode
        self.profile = profile
        self.with_runner = runner
        self.with_ticker = (mode == "live") if ticker is None else ticker
        self.lease_seconds = lease_seconds if lease_seconds is not None else (20 if mode == "eval" else None)
        self.claim_timeout_seconds = (
            claim_timeout_seconds if claim_timeout_seconds is not None else (10 if mode == "eval" else None)
        )
        self.extra_vars = extra_vars or {}
        self.processes: list[ManagedProcess] = []
        self._cleanup_registered = False

    # -- paths ---------------------------------------------------------------------------------------

    @property
    def wrangler_state(self) -> Path:
        return self.state_dir / "wrangler-state"

    @property
    def duckdb_path(self) -> Path:
        return self.state_dir / "warehouse" / "peoplelake.duckdb"

    @property
    def lake_dir(self) -> Path:
        return self.state_dir / "lake"

    def runner_env(self) -> dict[str, str]:
        return {
            "TZ": "UTC",
            "PL_TARGET": "local",
            "PL_PROFILE": self.profile,
            "PL_WORKER_URL": WORKER_URL,
            "PL_DUCKDB_PATH": str(self.duckdb_path),
            "PL_LAKE_DIR": str(self.lake_dir),
            "PL_REPO_ROOT": str(self.root),
            "PYTHONUNBUFFERED": "1",
        }

    # -- lifecycle -------------------------------------------------------------------------------------

    def reset_state(self) -> None:
        """Empty state for a scenario: Worker storage, local lake and warehouse."""
        import shutil

        for p in (self.wrangler_state, self.lake_dir, self.duckdb_path.parent):
            shutil.rmtree(p, ignore_errors=True)

    def _ensure_dev_keys(self) -> None:
        dev_vars = self.root / ".dev.vars"
        has = dev_vars.exists() and any(ln.startswith("DEV_ACCESS_JWKS=") for ln in dev_vars.read_text().splitlines())
        if not has or not (self.root / ".dev" / "keys" / "private.pem").exists():
            from .auth.dev_tokens import generate_dev_keys

            generate_dev_keys(self.root / ".dev" / "keys", dev_vars)

    def up(self, timeout: float = 90.0) -> None:
        busy = ports_busy((WRANGLER_PORT, INSPECTOR_PORT))
        if busy:
            raise StackError(f"ports already in use: {busy} (run `peoplelake stack down`)")
        self._ensure_dev_keys()
        self._register_cleanup()
        wrangler = [
            str(self.root / "node_modules" / ".bin" / "wrangler"),
            "dev",
            "--port",
            str(WRANGLER_PORT),
            "--inspector-port",
            str(INSPECTOR_PORT),
            "--ip",
            "127.0.0.1",
            "--persist-to",
            str(self.wrangler_state),
            "--log-level",
            "info",
        ]
        variables = dict(self.extra_vars)
        if self.lease_seconds is not None:
            variables["JOB_LEASE_SECONDS"] = str(self.lease_seconds)
        if self.claim_timeout_seconds is not None:
            variables["JOB_CLAIM_TIMEOUT_SECONDS"] = str(self.claim_timeout_seconds)
        for k, v in variables.items():
            wrangler += ["--var", f"{k}:{v}"]
        self._start(
            ManagedProcess("wrangler", wrangler, self.state_dir / "logs" / "wrangler.log", {"TZ": "UTC"}, self.root)
        )
        self._wait_health(timeout)
        if self.with_runner:
            self.start_runner()
        if self.with_ticker:
            ticker = [sys.executable, "-m", "peoplelake.cli", "stack", "ticker", "--worker-url", WORKER_URL]
            self._start(
                ManagedProcess("ticker", ticker, self.state_dir / "logs" / "ticker.log", self.runner_env(), self.root)
            )
        self._write_state()

    def start_runner(self) -> ManagedProcess:
        argv = [
            sys.executable,
            "-m",
            "peoplelake.cli",
            "runner",
            "poll",
            "--worker-url",
            WORKER_URL,
            "--target",
            "local",
            "--interval",
            "0.5",
        ]
        proc = ManagedProcess("runner", argv, self.state_dir / "logs" / "runner.log", self.runner_env(), self.root)
        self._start(proc)
        self._write_state()
        return proc

    def stop_runner(self) -> None:
        for p in [p for p in self.processes if p.name == "runner"]:
            if p.pid is not None:
                kill_group(p.pid)
            self.processes.remove(p)
        self._write_state()

    def _start(self, proc: ManagedProcess) -> None:
        proc.start()
        self.processes.append(proc)

    def _wait_health(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            wr = next((p for p in self.processes if p.name == "wrangler"), None)
            if wr is not None and not wr.alive():
                raise StackError(f"wrangler dev exited; see {wr.log_path}")
            try:
                if httpx.get(f"{WORKER_URL}/v1/health", timeout=1.0).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.3)
        raise StackError(f"Worker did not become healthy within {timeout} s")

    def down(self) -> list[int]:
        for p in reversed(self.processes):
            if p.pid is not None:
                kill_group(p.pid)
        self.processes.clear()
        stop_recorded(self.state_dir)
        return wait_ports_free((WRANGLER_PORT, INSPECTOR_PORT))

    def _write_state(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        state = {"mode": self.mode, "processes": [{"name": p.name, "pid": p.pid} for p in self.processes]}
        (self.state_dir / "state.json").write_text(json.dumps(state, indent=2))

    def _register_cleanup(self) -> None:
        if self._cleanup_registered:
            return
        self._cleanup_registered = True
        atexit.register(self.down)
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous = signal.getsignal(sig)

            def handler(signum, frame, previous=previous):  # noqa: ANN001
                self.down()
                if callable(previous):
                    previous(signum, frame)
                raise SystemExit(128 + signum)

            with contextlib.suppress(ValueError):  # not the main thread
                signal.signal(sig, handler)

    def __enter__(self) -> LocalStack:
        self.up()
        return self

    def __exit__(self, *exc: object) -> None:
        self.down()


def stop_recorded(state_dir: Path | None = None) -> None:
    """Kill every process group recorded in state.json (for `stack down` from another shell)."""
    state_dir = state_dir or data_dir() / "stack"
    path = state_dir / "state.json"
    if not path.exists():
        return
    try:
        state = json.loads(path.read_text())
    except json.JSONDecodeError:
        state = {"processes": []}
    for p in state.get("processes", []):
        if p.get("pid"):
            kill_group(int(p["pid"]))
    path.unlink(missing_ok=True)


def ticker(worker_url: str, interval: float = 60.0) -> None:
    """Calls the local scheduled handler (the stand-in for the Workers cron) every `interval` seconds."""
    paths = ["/cdn-cgi/handler/scheduled?cron=*+*+*+*+*", "/__scheduled?cron=*+*+*+*+*"]
    while True:
        for path in paths:
            try:
                if httpx.get(f"{worker_url}{path}", timeout=10).status_code < 400:
                    break
            except httpx.HTTPError:
                continue
        time.sleep(interval)
