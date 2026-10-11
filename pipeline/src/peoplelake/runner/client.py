"""HTTP client for the Worker: runner, operator and dev routes."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from urllib.parse import quote

import httpx

from ..auth.dev_tokens import AccessHeaders
from ..lake.committer import SinkFile


class WorkerError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class WorkerClient:
    def __init__(self, base_url: str, headers: AccessHeaders, *, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = headers
        self.http = httpx.Client(base_url=self.base_url, timeout=timeout)

    def close(self) -> None:
        self.http.close()

    def _req(self, method: str, path: str, **kw: Any) -> httpx.Response:
        headers = {**self.headers(), **kw.pop("headers", {})}
        return self.http.request(method, path, headers=headers, **kw)

    def _json(self, method: str, path: str, ok: tuple[int, ...] = (200, 202), **kw: Any) -> Any:
        res = self._req(method, path, **kw)
        if res.status_code not in ok:
            raise WorkerError(res.status_code, res.text)
        return res.json() if res.content else None

    # -- runner ---------------------------------------------------------------------------------------

    def claim(self, worker_id: str) -> dict | None:
        res = self._req("POST", "/internal/jobs/claim", json={"worker_id": worker_id})
        if res.status_code == 204:
            return None
        if res.status_code != 200:
            raise WorkerError(res.status_code, res.text)
        return res.json()

    def heartbeat(self, job_id: str, worker_id: str) -> bool:
        res = self._req("POST", f"/internal/jobs/{job_id}/heartbeat", json={"worker_id": worker_id})
        return res.status_code == 200

    def result(self, job_id: str, result: dict) -> dict:
        return self._json("POST", f"/internal/jobs/{job_id}/result", json=result)

    def put_metrics(self, run_id: str, body: str) -> dict:
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        return self._json(
            "PUT",
            f"/internal/runs/{run_id}/artifacts/metrics?sha256={sha}",
            content=body.encode("utf-8"),
            headers={"content-type": "application/json"},
        )

    # -- local stand-in sink files (runner) -------------------------------------------------------------

    def sink_files(self, after: str | None = None) -> list[SinkFile]:
        path = "/internal/dev/sink/files" + (f"?after={quote(after)}" if after else "")
        body = self._json("GET", path)
        return [SinkFile(f["key"], f["etag"], int(f["size"])) for f in body["files"]]

    def sink_file(self, key: str) -> bytes:
        res = self._req("GET", f"/internal/dev/sink/files/{key}")
        if res.status_code != 200:
            raise WorkerError(res.status_code, res.text)
        return res.content

    # -- operator ---------------------------------------------------------------------------------------

    def flush_sink(self) -> dict:
        return self._json("POST", "/internal/dev/sink/flush")

    def install_faults(self, faults: list[dict]) -> dict:
        return self._json("POST", "/internal/dev/faults", json={"faults": faults})

    def request_run(self, mode: str = "incremental") -> dict:
        return self._json("POST", "/api/replay" if mode == "replay" else "/api/runs")

    def replay(self, *, to_snapshot: str | None = None, dataset_suffix: str | None = None) -> dict:
        body = {k: v for k, v in (("to_snapshot", to_snapshot), ("dataset_suffix", dataset_suffix)) if v is not None}
        return self._json("POST", "/api/replay", json=body)

    def runs(self, limit: int = 200, fmt: str = "full") -> list[dict]:
        return self._json("GET", f"/api/runs?limit={limit}&format={fmt}")["runs"]

    def run(self, run_id: str) -> dict:
        return self._json("GET", f"/api/runs/{run_id}")

    def status(self) -> dict:
        return self._json("GET", "/api/status")

    def freshness(self, window: str = "24h") -> dict:
        return self._json("GET", f"/api/freshness?window={window}")

    def metrics_latest(self) -> dict:
        return self._json("GET", "/api/metrics/latest")

    # -- sources ------------------------------------------------------------------------------------------

    def ingest(self, source: str, envelopes: list[str]) -> dict:
        key = {"hris": "events", "ats": "records", "talent": "items"}[source]
        body = '{"' + key + '":[' + ",".join(envelopes) + "]}"
        return self._json(
            "POST", f"/v1/ingest/{source}", content=body.encode("ascii"), headers={"content-type": "application/json"}
        )


class WorkerSinkSource:
    """The SinkRoller roll files, read through the Worker's local-only routes (committer input)."""

    def __init__(self, client: WorkerClient) -> None:
        self.client = client

    def list_files(self) -> list[SinkFile]:
        return self.client.sink_files()

    def get(self, key: str) -> bytes:
        return self.client.sink_file(key)


def canonical_body(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))
