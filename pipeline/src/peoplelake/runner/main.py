"""Runner loop (SPEC 10.2). Locally `peoplelake runner poll` (a process the stack manager starts); in
production the Cloud Run Job runs `peoplelake runner run --until-idle 15 --target prod`.

One process owns the local DuckDB file (ADR 0008): loads, in-process dbt, digests and freshness
histograms all happen here, and results carry what evals need. Logs carry counts only.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
from pathlib import Path

from ..auth.dev_tokens import AccessHeaders
from ..config import Settings, load_settings, open_lake
from ..warehouse.dbt_runner import DbtRunner, env_overrides
from ..warehouse.loader import run_load
from .client import WorkerClient, WorkerLandingSource
from .jobs import Faults, SimulatedCrash, failed_result, run_transform

log = logging.getLogger("peoplelake.runner")
MAX_JOBS_PER_PROCESS = 200


class Heartbeat:
    def __init__(self, client: WorkerClient, job: dict, worker_id: str) -> None:
        self.client = client
        self.job = job
        self.worker_id = worker_id
        self.lost = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        interval = max(1.0, self.job["lease_seconds"] / 3)
        while not self._stop.wait(interval):
            try:
                if not self.client.heartbeat(self.job["job_id"], self.worker_id):
                    self.lost = True
            except Exception:  # noqa: BLE001 - a failed heartbeat must not kill the job
                log.warning("heartbeat failed for %s", self.job["job_id"])

    def __enter__(self) -> Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


def duckdb_path_for(settings: Settings, suffix: str | None) -> Path:
    if not suffix:
        return settings.duckdb_path
    return settings.duckdb_path.with_name(f"{settings.duckdb_path.stem}-{suffix}{settings.duckdb_path.suffix}")


class Runner:
    def __init__(self, settings: Settings, client: WorkerClient, worker_id: str | None = None) -> None:
        self.settings = settings
        self.client = client
        self.worker_id = worker_id or f"{socket.gethostname()}-{os.getpid()}"
        self.current: dict | None = None
        self.counts: dict[str, int] = {}

    # -- targets -------------------------------------------------------------------------------------

    def _warehouse(self, suffix: str | None):
        if self.settings.target == "local":
            from ..warehouse.duckdb_wh import DuckDBWarehouse

            return DuckDBWarehouse(duckdb_path_for(self.settings, suffix))
        from ..warehouse.bigquery_wh import BigQueryWarehouse, bigquery_client

        drill = "drill" if self.settings.target == "prod-drill" else None
        project = self.settings.gcp_project
        if not project:
            raise RuntimeError("PL_GCP_PROJECT is not set")
        # prod: the Cloud Run Job's attached service account; prod-drill: the operator's ADC impersonating peoplelake-runner.
        impersonate = os.environ.get("PL_RUNNER_SA") if drill else None
        client = bigquery_client(project, self.settings.bq_location, impersonate)
        return BigQueryWarehouse(client, project, location=self.settings.bq_location, suffix=suffix or drill)

    def _dbt_env(self, suffix: str | None) -> dict[str, str | None]:
        env: dict[str, str | None] = {"PL_PROFILE": self.settings.profile}
        if self.settings.target == "local":
            env["PL_DUCKDB_PATH"] = str(duckdb_path_for(self.settings, suffix))
            env["PL_DATASET_SUFFIX"] = None
        else:
            env["PL_DATASET_SUFFIX"] = suffix or ("drill" if self.settings.target == "prod-drill" else None)
        return env

    def _dbt(self, suffix: str | None) -> DbtRunner:
        base = self.settings.duckdb_path.parent / "dbt-target"
        return DbtRunner(target=self.settings.target, target_path=base / (suffix or "main"))

    # -- jobs ----------------------------------------------------------------------------------------

    def process(self, job: dict) -> str:
        faults = Faults.from_job(job)
        if faults.skip_claim:
            log.info("eval fault skip_claim: %s claimed and dropped", job["job_id"])
            return "skipped"
        self.current = job
        suffix = job["input"].get("dataset_suffix")
        started = time.monotonic()
        try:
            with Heartbeat(self.client, job, self.worker_id), env_overrides(self._dbt_env(suffix)):
                warehouse = self._warehouse(suffix)
                if job["kind"] == "load":
                    # Every target commits new landing rolls first: the lake catalog is SqlCatalog locally (and
                    # for prod-drill, which keeps the local Worker and lake) and Basin Catalog in production.
                    table = open_lake(self.settings)
                    landing = WorkerLandingSource(self.client)
                    outcome = run_load(job, table=table, warehouse=warehouse, landing=landing, recommit=faults.recommit)
                    result = outcome.result
                    log.info(
                        "load %s: read %s, inserted %s, duplicates %s, snapshots %s",
                        job["job_id"],
                        result["rows_read"],
                        result["rows_inserted"],
                        result["duplicate_deliveries_skipped"],
                        result["lake"]["snapshots_read"],
                    )
                    if faults.crash_after_load:
                        raise SimulatedCrash(job["job_id"])
                else:
                    result = run_transform(
                        job,
                        warehouse=warehouse,
                        dbt=self._dbt(suffix),
                        upload=self.client.put_metrics,
                        profile=self.settings.profile,
                        faults=faults,
                    )
                    log.info("transform %s: %s in %s ms", job["job_id"], result["status"], result["duration_ms"])
            self._report(job, result, twice=faults.duplicate_result)
            return result["status"]
        except SimulatedCrash:
            log.info("eval fault crash_after_load: %s loaded and not reported", job["job_id"])
            return "crashed"
        except BaseException as exc:  # noqa: BLE001 - report anything, including SIGTERM
            try:
                self._report(job, failed_result(job, f"{type(exc).__name__}: {exc}", started))
            except Exception:  # noqa: BLE001
                log.exception("could not report failure for %s", job["job_id"])
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            log.exception("job %s failed", job["job_id"])
            return "failed"
        finally:
            self.current = None

    def _report(self, job: dict, result: dict, twice: bool = False) -> None:
        res = self.client.result(job["job_id"], result)
        if twice:
            dup = self.client.result(job["job_id"], result)
            log.info("eval fault duplicate_result: second report duplicate=%s", dup.get("duplicate"))
        if res.get("duplicate"):
            log.info("result for %s was a duplicate (job already terminal)", job["job_id"])

    def poll(
        self, *, until_idle: float | None = None, interval: float = 1.0, max_jobs: int = MAX_JOBS_PER_PROCESS
    ) -> int:
        """Claim and run jobs. With until_idle, exit after that many idle seconds; returns jobs processed."""
        processed = 0
        idle_since = time.monotonic()
        while processed < max_jobs:
            try:
                job = self.client.claim(self.worker_id)
            except Exception:  # noqa: BLE001 - the Worker may be restarting
                log.warning("claim failed; retrying")
                job = None
            if job is None:
                if until_idle is not None and time.monotonic() - idle_since >= until_idle:
                    break
                time.sleep(interval)
                continue
            outcome = self.process(job)
            self.counts[outcome] = self.counts.get(outcome, 0) + 1
            processed += 1
            idle_since = time.monotonic()
        return processed


def build_runner(target: str | None, worker_url: str | None) -> Runner:
    settings = load_settings(target)  # type: ignore[arg-type]
    if worker_url:
        settings.worker_url = worker_url
    # Local and prod-drill talk to the local Worker with dev JWTs; production sends Access service-token headers.
    headers = AccessHeaders(
        local=settings.target != "prod",
        identity="runner",
        keys_dir=settings.dev_keys_dir,
        client_id=settings.cf_access_client_id,
        client_secret=settings.cf_access_client_secret,
    )
    return Runner(settings, WorkerClient(settings.worker_url, headers))


def install_sigterm_handler() -> None:
    def handler(signum: int, frame: object) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, handler)
