"""`peoplelake eval ask`: question file shape, scoring, provider labeling and the local stub path."""

from __future__ import annotations

import json
import re

import pytest

from peoplelake.evals.ask import (
    FIELDS,
    AskEvalError,
    Question,
    budget_exhausted,
    evaluate,
    evaluate_resumable,
    load_questions,
    percentile,
    report,
    score_one,
    summarize,
)

MONTH = re.compile(r"^202[3-5]-(0[1-9]|1[0-2])$")
DEPARTMENT = re.compile(r"^(ALL|D(0[1-9]|1[0-2]))$")
METRICS = {"headcount", "fte", "hires", "departures", "offer_acceptance_rate"}


def test_questions_file_has_sixty_valid_questions() -> None:
    questions = load_questions()
    assert len(questions) == 60
    assert len({q.id for q in questions}) == 60
    assert len({q.question.lower() for q in questions}) == 60
    for q in questions:
        e = q.expected
        assert set(e) == set(FIELDS), q.id
        assert e["metric"] in METRICS, q.id
        assert DEPARTMENT.match(e["department_id"]), q.id
        assert MONTH.match(e["start_month"]) and MONTH.match(e["end_month"]), q.id
        assert e["start_month"] <= e["end_month"], q.id
    for metric in METRICS:
        assert sum(q.expected["metric"] == metric for q in questions) == 12


def test_score_one_counts_fields_and_exact_match() -> None:
    expected = {"metric": "hires", "department_id": "D01", "start_month": "2024-01", "end_month": "2024-06"}
    assert score_one(expected, dict(expected)) == {**dict.fromkeys(FIELDS, True), "exact": True}
    wrong_end = {**expected, "end_month": "2024-12"}
    assert score_one(expected, wrong_end) == {
        "metric": True,
        "department_id": True,
        "start_month": True,
        "end_month": False,
        "exact": False,
    }
    assert score_one(expected, None) == {**dict.fromkeys(FIELDS, False), "exact": False}


def test_percentile_is_nearest_rank() -> None:
    assert percentile([], 50) is None
    assert percentile([5.0], 95) == 5.0
    values = [float(v) for v in range(1, 101)]
    assert percentile(values, 50) == 50.0
    assert percentile(values, 95) == 95.0
    assert percentile([3.0, 1.0, 2.0], 50) == 2.0


def _questions() -> list[Question]:
    return [
        Question(
            "q1", "a", {"metric": "hires", "department_id": "ALL", "start_month": "2024-01", "end_month": "2024-12"}
        ),
        Question(
            "q2", "b", {"metric": "fte", "department_id": "D02", "start_month": "2023-01", "end_month": "2023-03"}
        ),
        Question(
            "q3", "c", {"metric": "fte", "department_id": "D03", "start_month": "2025-01", "end_month": "2025-01"}
        ),
    ]


def test_evaluate_and_summarize_with_invalid_answers() -> None:
    qs = _questions()
    answers = {
        "a": (200, {"provider": "stub", "model": None, "query": qs[0].expected}),
        "b": (200, {"provider": "stub", "model": None, "query": {**qs[1].expected, "department_id": "ALL"}}),
        "c": (422, {"error": "stub returned an invalid query"}),
    }
    rows = evaluate(qs, lambda question: answers[question], "stub")
    s = summarize(rows)
    assert s["questions"] == 3
    assert s["exact_match"] == 1
    assert s["invalid_answers"] == 1
    assert s["field_accuracy"] == {
        "metric": 0.6667,
        "department_id": 0.3333,
        "start_month": 0.6667,
        "end_month": 0.6667,
    }
    assert s["by_metric"] == {"hires": {"questions": 1, "exact": 1}, "fte": {"questions": 2, "exact": 0}}
    assert rows[2]["got"] is None and rows[2]["status"] == 422


def test_evaluate_refuses_an_answer_from_another_provider() -> None:
    qs = _questions()[:1]
    with pytest.raises(AskEvalError, match="provider 'stub'"):
        evaluate(qs, lambda _q: (200, {"provider": "stub", "query": qs[0].expected}), "llama")


def test_report_labels_provider_target_and_questions_hash() -> None:
    qs = _questions()[:1]
    rows = evaluate(qs, lambda _q: (200, {"provider": "openai-compatible", "query": qs[0].expected}), "llama")
    rep = report("llama", {"rows": rows, "model": "x.gguf", "target": "local", "worker": "w"}, "peoplelake eval ask")
    assert rep["kind"] == "ask"
    assert rep["provider"] == "llama" and rep["model"] == "x.gguf" and rep["target"] == "local"
    assert "stand-in" in rep["provider_label"]
    assert len(rep["questions_sha256"]) == 64
    assert rep["summary"]["exact_match"] == 1


def _workers_ai(questions: list[Question], budget: int) -> tuple:
    """A fake production Worker: answers correctly until `budget` calls, then 429 ai_budget."""
    calls = {"n": 0}

    def ask(question: str) -> tuple[int, dict]:
        if calls["n"] >= budget:
            return 429, {"error": "ai_budget", "detail": "1800 of 1800 neurons used today (UTC)"}
        calls["n"] += 1
        q = next(q for q in questions if q.question == question)
        return 200, {
            "provider": "workers-ai",
            "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            "query": q.expected,
            "usage": {"calls": 1, "neurons_reserved": 34},
        }

    return ask, calls


def test_workers_ai_eval_checkpoints_stops_at_the_cap_and_resumes_on_a_later_day(tmp_path) -> None:
    qs = load_questions()
    checkpoint = tmp_path / "ask-workers-ai.checkpoint.json"
    ask, _ = _workers_ai(qs, budget=25)
    first = evaluate_resumable(
        qs, ask, "workers-ai", checkpoint=checkpoint, resume=False, questions_hash="h", today=lambda: "2026-10-12"
    )
    assert not first["complete"] and first["stopped"] == "ai_budget"
    saved = json.loads(checkpoint.read_text())
    assert len(saved["rows"]) == 25 and saved["days"] == ["2026-10-12"]  # every answered question was saved
    with pytest.raises(AskEvalError, match="--resume"):
        evaluate_resumable(qs, ask, "workers-ai", checkpoint=checkpoint, resume=False, questions_hash="h")
    with pytest.raises(AskEvalError, match="other questions"):
        evaluate_resumable(qs, ask, "workers-ai", checkpoint=checkpoint, resume=True, questions_hash="other")
    ask2, calls2 = _workers_ai(qs, budget=1000)
    second = evaluate_resumable(
        qs, ask2, "workers-ai", checkpoint=checkpoint, resume=True, questions_hash="h", today=lambda: "2026-10-13"
    )
    assert second["complete"] and second["stopped"] is None
    assert calls2["n"] == 35  # only the unanswered questions were asked again
    assert [r["id"] for r in second["rows"]] == [q.id for q in qs]
    assert second["days"] == ["2026-10-12", "2026-10-13"]
    assert (second["calls"], second["neurons_reserved"]) == (60, 60 * 34)


def test_results_are_written_only_for_a_complete_run_and_name_the_model(tmp_path, monkeypatch) -> None:
    from peoplelake.evals import ask as ask_mod

    qs = load_questions()
    monkeypatch.setattr(ask_mod, "checkpoint_path", lambda: tmp_path / "cp.json")

    class Op:
        base_url = "https://peoplelake.example.workers.dev"
        http = None

        def headers(self):
            return {}

        def close(self):
            pass

    fake, _ = _workers_ai(qs, budget=10)
    monkeypatch.setattr("peoplelake.evals.freshness.prod_operator", lambda: Op())
    monkeypatch.setattr(ask_mod, "_http_ask", lambda http, headers: fake)
    with pytest.raises(ask_mod.AskEvalIncomplete, match="stopped after 10 of 60"):
        ask_mod.run_prod(qs)
    fake, _ = _workers_ai(qs, budget=1000)
    monkeypatch.setattr(ask_mod, "_http_ask", lambda http, headers: fake)
    outcome = ask_mod.run_prod(qs, resume=True)
    rep = report("workers-ai", outcome, "peoplelake eval ask --provider workers-ai --resume")
    assert rep["model"] == "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    assert rep["summary"]["questions"] == 60 and rep["calls"] == 60 and rep["neurons_estimated"] == 2040.0
    assert len(rep["days"]) >= 1


def test_budget_answers_are_the_429_or_the_daily_allocation_error() -> None:
    assert budget_exhausted(429, {"error": "ai_budget"})
    assert budget_exhausted(502, {"error": "4006: you have used up your daily free allocation of 10,000 neurons"})
    assert not budget_exhausted(502, {"error": "local LLM unreachable"})
    assert not budget_exhausted(422, {"error": "workers-ai returned an invalid query"})


@pytest.mark.e2e
def test_stub_eval_through_wrangler_dev_leaves_ports_free() -> None:
    from peoplelake.evals.ask import run_local
    from peoplelake.stack import ports_busy

    if ports_busy():
        pytest.skip("ports 8791, 9241 or 8150 are in use")
    questions = load_questions()[:5]
    outcome = run_local("stub", questions)
    assert outcome["target"] == "local"
    assert len(outcome["rows"]) == 5
    assert all(r["status"] in (200, 422) for r in outcome["rows"])
    assert ports_busy() == []
