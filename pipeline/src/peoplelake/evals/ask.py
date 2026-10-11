"""`peoplelake eval ask`: how well each AiProvider turns a question into the intended MetricQuery.

Every question in `evals/ask/questions.jsonl` goes to the Worker's `POST /api/ask/query`, the same
provider code path `/api/ask` uses, so the number describes what the deployed route does:

  stub        wrangler dev with AI_PROVIDER=stub (deterministic rule parser, no model)
  llama       wrangler dev with AI_PROVIDER=openai-compatible and llama-server on 127.0.0.1:8150
              (local stand-in for Workers AI; the GGUF it serves is recorded in the result)
  workers-ai  the production Worker (Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through AI
              Gateway), with the doctor's service token

Scores: exact match on all four fields, accuracy per field, invalid answers (the provider produced no
valid query: HTTP 422 or 502) and client-side latency. Answers are never tuned to these questions.

Workers AI on the Workers Free plan (SPEC 29.4.5): the Worker caps this repo at 1,800 neurons a UTC day
and answers 429 `ai_budget` past it. The workers-ai eval therefore checkpoints every answered question in
`.data/eval/ask-workers-ai.checkpoint.json`, stops at the cap (or at Workers AI's own daily limit), and
`--resume` continues on a later UTC day; the results file is written only when all questions are
answered, with the model, the UTC days used, the model calls and the neurons the Worker reserved.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
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


class AskEvalIncomplete(AskEvalError):
    """The daily Workers AI budget stopped the eval; `--resume` continues on a later UTC day."""


def checkpoint_path() -> Path:
    return data_dir() / "eval" / "ask-workers-ai.checkpoint.json"


def budget_exhausted(status: int, body: dict) -> bool:
    """The Worker's 429 ai_budget, or Workers AI's own daily allowance error passed through as a 502."""
    if status == 429:
        return True
    text = str(body.get("error", ""))
    return (
        status == 502
        and re.search(r"\b4006\b|neurons?|daily (free )?allocation|daily limit", text, re.IGNORECASE) is not None
    )


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


def _utc_today() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m-%d")


def _save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def evaluate_resumable(
    questions: list[Question],
    ask: AskFn,
    provider: str,
    *,
    checkpoint: Path,
    resume: bool,
    questions_hash: str,
    today: Callable[[], str] = _utc_today,
) -> dict:
    """Like `evaluate`, but every answered question is saved to `checkpoint` at once, and a budget answer
    (429 ai_budget, or Workers AI's daily limit) stops the run with the question unanswered."""
    if checkpoint.exists() and not resume:
        raise AskEvalError(f"a checkpoint exists at {checkpoint}: continue with --resume, or delete it to start over")
    if resume and checkpoint.exists():
        state = json.loads(checkpoint.read_text())
        if state.get("questions_sha256") != questions_hash or state.get("provider") != provider:
            raise AskEvalError(f"{checkpoint} belongs to other questions or another provider; delete it to start over")
    else:
        state = {
            "provider": provider,
            "questions_sha256": questions_hash,
            "days": [],
            "rows": [],
            "calls": 0,
            "neurons_reserved": 0,
        }
    done = {r["id"] for r in state["rows"]}
    stopped = None
    for q in questions:
        if q.id in done:
            continue
        t0 = time.monotonic()
        status, body = ask(q.question)
        latency_ms = round((time.monotonic() - t0) * 1000, 1)
        if budget_exhausted(status, body):
            stopped = str(body.get("error", f"HTTP {status}"))[:200]
            break
        if status == 200 and body.get("provider") != PROVIDERS[provider]:
            raise AskEvalError(
                f"the Worker answered with provider {body.get('provider')!r}, expected {PROVIDERS[provider]!r}"
            )
        got = body.get("query") if status == 200 else None
        usage = body.get("usage") or {}
        state["rows"].append(
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
        state["calls"] += int(usage.get("calls", 1))
        state["neurons_reserved"] += float(usage.get("neurons_reserved", 0))
        day = today()
        if day not in state["days"]:
            state["days"].append(day)
        _save(checkpoint, state)
    complete = len(state["rows"]) == len(questions) and stopped is None
    return {**state, "complete": complete, "stopped": stopped}


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


def run_prod(questions: list[Question], *, resume: bool = False) -> dict:
    """workers-ai against the production Worker with the doctor's service token (operator role); resumable
    across UTC days under the Worker's daily neuron cap."""
    from .freshness import prod_operator

    op = prod_operator()
    path = checkpoint_path()
    try:
        state = evaluate_resumable(
            questions,
            _http_ask(op.http, op.headers),
            "workers-ai",
            checkpoint=path,
            resume=resume,
            questions_hash=questions_sha256(),
        )
    finally:
        op.close()
    if not state["complete"]:
        raise AskEvalIncomplete(
            f"stopped after {len(state['rows'])} of {len(questions)} questions ({state['stopped']}); "
            f"the checkpoint is {path}: run `peoplelake eval ask --provider workers-ai --resume` on a later UTC day"
        )
    rows = state["rows"]
    model = next((r["model"] for r in rows if r["model"]), None)
    return {
        "rows": rows,
        "model": model,
        "target": "prod",
        "worker": op.base_url,
        "days": sorted(state["days"]),
        "calls": state["calls"],
        "neurons_estimated": round(state["neurons_reserved"], 1),
        "checkpoint": path,
    }


def report(provider: str, outcome: dict, command: str) -> dict:
    from datetime import UTC, datetime

    labels = {
        "stub": "deterministic rule parser in the Worker (no model)",
        "llama": "llama-server on 127.0.0.1:8150 (local stand-in for Workers AI)",
        "workers-ai": "Workers AI through AI Gateway peoplelake (production, max_tokens 96, 1,800 neurons a UTC day)",
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
        **{k: outcome[k] for k in ("days", "calls", "neurons_estimated") if k in outcome},
    }


def write(rep: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n")
