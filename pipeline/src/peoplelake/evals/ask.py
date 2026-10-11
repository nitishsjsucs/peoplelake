"""`peoplelake eval ask`: how well each AiProvider turns a question into the intended MetricQuery.

Every question in `evals/ask/questions.jsonl` goes to the Worker's `POST /api/ask/query`, the same
provider code path `/api/ask` uses, so the number describes what the deployed route does:

  stub        wrangler dev with AI_PROVIDER=stub (deterministic rule parser, no model)
  llama       wrangler dev with AI_PROVIDER=openai-compatible and llama-server on 127.0.0.1:8150
              (local stand-in for Workers AI; the GGUF it serves is recorded in the result)
  workers-ai  the production Worker (Workers AI through AI Gateway), with the pl-doctor service token

Scores: exact match on all four fields, accuracy per field, invalid answers (the provider produced no
valid query: HTTP 422 or 502) and client-side latency. Answers are never tuned to these questions.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..paths import data_dir, repo_root

FIELDS = ("metric", "department_id", "start_month", "end_month")
PROVIDERS = {"stub": "stub", "llama": "openai-compatible", "workers-ai": "workers-ai"}
DEFAULT_GGUF = Path.home() / "Developer" / "projects" / "_models" / "Qwen3-1.7B-Q4_0-rtn.gguf"
LLAMA_URL = "http://127.0.0.1:8150"


class AskEvalError(RuntimeError):
    pass


@dataclass(frozen=True)
class Question:
    id: str
    question: str
    expected: dict[str, str]


def questions_path() -> Path:
    return repo_root() / "evals" / "ask" / "questions.jsonl"


def load_questions(path: Path | None = None) -> list[Question]:
    out = []
    for line in (path or questions_path()).read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            out.append(Question(row["id"], row["question"], row["expected"]))
    return out


def questions_sha256(path: Path | None = None) -> str:
    return hashlib.sha256((path or questions_path()).read_bytes()).hexdigest()


def score_one(expected: dict[str, str], got: dict[str, str] | None) -> dict[str, bool]:
    fields = {f: got is not None and got.get(f) == expected[f] for f in FIELDS}
    return {**fields, "exact": all(fields.values())}


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * p // 100))
    return ordered[int(rank) - 1]


def summarize(rows: list[dict]) -> dict:
    n = len(rows)
    latencies = [r["latency_ms"] for r in rows]
    by_metric: dict[str, dict[str, int]] = {}
    for r in rows:
        m = r["expected"]["metric"]
        slot = by_metric.setdefault(m, {"questions": 0, "exact": 0})
        slot["questions"] += 1
        slot["exact"] += int(r["score"]["exact"])
    return {
        "questions": n,
        "exact_match": sum(r["score"]["exact"] for r in rows),
        "exact_match_rate": round(sum(r["score"]["exact"] for r in rows) / n, 4) if n else None,
        "field_accuracy": {f: round(sum(r["score"][f] for r in rows) / n, 4) if n else None for f in FIELDS},
        "invalid_answers": sum(r["got"] is None for r in rows),
        "by_metric": by_metric,
        "latency_ms": {
            "p50": percentile(latencies, 50),
            "p95": percentile(latencies, 95),
            "max": max(latencies, default=None),
        },
    }


AskFn = Callable[[str], tuple[int, dict]]


def evaluate(questions: Iterable[Question], ask: AskFn, provider: str) -> list[dict]:
    """Ask every question once; a response from a different provider than requested is an error."""
    rows = []
    for q in questions:
        t0 = time.monotonic()
        status, body = ask(q.question)
        latency_ms = round((time.monotonic() - t0) * 1000, 1)
        if status == 200 and body.get("provider") != PROVIDERS[provider]:
            raise AskEvalError(
                f"the Worker answered with provider {body.get('provider')!r}, expected {PROVIDERS[provider]!r}"
            )
        got = body.get("query") if status == 200 else None
        rows.append(
            {
                "id": q.id,
                "question": q.question,
                "expected": q.expected,
                "got": got,
                "model": body.get("model") if status == 200 else None,
                "status": status,
                "error": None if status == 200 else str(body.get("error", ""))[:200],
                "latency_ms": latency_ms,
                "score": score_one(q.expected, got),
            }
        )
    return rows


def _http_ask(client: httpx.Client, headers: Callable[[], dict[str, str]]) -> AskFn:
    def ask(question: str) -> tuple[int, dict]:
        res = client.post("/api/ask/query", json={"question": question}, headers=headers())
        try:
            body = res.json()
        except ValueError:
            body = {"error": res.text[:200]}
        if res.status_code in (401, 403, 404, 500):
            raise AskEvalError(f"/api/ask/query returned HTTP {res.status_code}: {res.text[:200]}")
        return res.status_code, body

    return ask


def _wait_llama(proc, timeout: float = 120.0) -> None:  # noqa: ANN001
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not proc.alive():
            raise AskEvalError(f"llama-server exited; see {proc.log_path}")
        try:
            if httpx.get(f"{LLAMA_URL}/health", timeout=1.0).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise AskEvalError(f"llama-server did not become healthy within {timeout} s")


def run_local(provider: str, questions: list[Question], *, gguf: Path | None = None) -> dict:
    """stub or llama through `wrangler dev` on 127.0.0.1:8791; every process is stopped afterwards."""
    from ..auth.dev_tokens import AccessHeaders
    from ..stack import LLAMA_PORT, WORKER_URL, LocalStack, ManagedProcess, kill_group, port_in_use, wait_ports_free

    state_dir = data_dir() / "eval" / "ask"
    stack = LocalStack(
        state_dir=state_dir,
        mode="eval",
        runner=False,
        ticker=False,
        extra_vars={"AI_PROVIDER": PROVIDERS[provider]},
    )
    stack.reset_state()
    llama = None
    model = None
    try:
        if provider == "llama":
            gguf = gguf or Path(os.environ.get("PL_LLAMA_GGUF", str(DEFAULT_GGUF)))
            binary = os.environ.get("PL_LLAMA_SERVER") or shutil.which("llama-server")
            if not binary or not gguf.exists():
                raise AskEvalError(f"llama needs llama-server on PATH and the GGUF at {gguf} (PL_LLAMA_GGUF)")
            if port_in_use(LLAMA_PORT):
                raise AskEvalError(f"port {LLAMA_PORT} is already in use")
            argv = [binary, "-m", str(gguf), "--host", "127.0.0.1", "--port", str(LLAMA_PORT)]
            argv += ["-np", "1", "-c", "8192", "-ngl", "99"]
            llama = ManagedProcess("llama-server", argv, state_dir / "logs" / "llama-server.log")
            llama.start()
            stack.processes.append(llama)  # stopped by stack.down() as well
            _wait_llama(llama)
            model = gguf.name
        stack.up()
        headers = AccessHeaders(local=True, identity="operator", keys_dir=stack.root / ".dev" / "keys")
        with httpx.Client(base_url=WORKER_URL, timeout=120.0) as client:
            rows = evaluate(questions, _http_ask(client, headers), provider)
    finally:
        stack.down()
        if llama is not None and llama.pid is not None:
            kill_group(llama.pid)
        busy = wait_ports_free()
        if busy:
            raise AskEvalError(f"ports still busy after the eval: {busy}")
    return {"rows": rows, "model": model, "target": "local", "worker": "wrangler dev (Miniflare) on 127.0.0.1:8791"}


def run_prod(questions: list[Question]) -> dict:
    """workers-ai against the production Worker with the pl-doctor service token (operator role)."""
    from .freshness import prod_operator

    op = prod_operator()
    try:
        rows = evaluate(questions, _http_ask(op.http, op.headers), "workers-ai")
    finally:
        op.close()
    model = next((r["model"] for r in rows if r["model"]), None)
    return {"rows": rows, "model": model, "target": "prod", "worker": op.base_url}


def report(provider: str, outcome: dict, command: str) -> dict:
    from datetime import UTC, datetime

    labels = {
        "stub": "deterministic rule parser in the Worker (no model)",
        "llama": "llama-server on 127.0.0.1:8150 (local stand-in for Workers AI)",
        "workers-ai": "Workers AI through AI Gateway peoplelake (production)",
    }
    return {
        "kind": "ask",
        "command": command,
        "date": datetime.now(UTC).strftime("%Y-%m-%d"),
        "provider": provider,
        "provider_label": labels[provider],
        "model": outcome["model"],
        "target": outcome["target"],
        "worker": outcome["worker"],
        "route": "POST /api/ask/query",
        "questions_file": "evals/ask/questions.jsonl",
        "questions_sha256": questions_sha256(),
        "machine": f"{platform.system()} {platform.machine()}",
        "summary": summarize(outcome["rows"]),
        "results": outcome["rows"],
    }


def write(rep: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n")
