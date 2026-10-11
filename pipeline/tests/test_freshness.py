"""Freshness summary math shared with the Worker's /api/freshness (nearest rank on weighted values), and
the production measurement's refusal to report over a partial ledger."""

import pytest

from peoplelake.evals.freshness import summarize, weighted_percentile


def test_weighted_percentile_nearest_rank():
    values = [(10.0, 1), (20.0, 1), (30.0, 1), (40.0, 1)]
    assert weighted_percentile(values, 0.5) == 20.0
    assert weighted_percentile(values, 0.95) == 40.0
    assert weighted_percentile([(5.0, 99), (900.0, 1)], 0.95) == 5.0
    assert weighted_percentile([(5.0, 94), (900.0, 6)], 0.95) == 900.0
    assert weighted_percentile([], 0.5) is None


def test_summary_share_within_15_minutes_and_order_independence():
    values = [(899.0, 3), (900.0, 1), (901.0, 1), (60.0, 5)]
    s = summarize(values)
    assert s["events"] == 10
    assert s["share_within_15m"] == 0.9
    assert s["max_s"] == 901.0
    assert summarize(list(reversed(values))) == s


class FakeOperator:
    def __init__(self, buckets, active=None):
        self.buckets = buckets
        self.active = active

    def freshness(self, window):
        published = sum(b["events"] for b in self.buckets if b["published_at"])
        pending = sum(b["events"] for b in self.buckets if not b["published_at"])
        return {"buckets": self.buckets, "overall": {"events": published, "pending_events": pending}}

    def all_runs(self, fmt, since=0):
        return [{"status": "committed"}]

    def status(self):
        return {"run_seq": "0", "active_run_id": self.active}


DELIVERY = {
    "delivery_id": "d-1",
    "profile": "small",
    "started_at": "2026-10-11T00:00:00Z",
    "records": 10_000,
    "duration_minutes": 60,
}
START_S = 1_791_676_800  # 2026-10-11T00:00:00Z


def test_ledger_coverage_flags_a_partial_ledger():
    from peoplelake.evals.freshness import ledger_coverage

    assert ledger_coverage(10_000, 0, 10_000)["complete"] is True
    partial = ledger_coverage(9_500, 0, 10_000)
    assert partial["complete"] is False and partial["coverage"] == 0.95
    assert ledger_coverage(10_000, 3, 10_000)["complete"] is False


def test_production_freshness_refuses_percentiles_over_a_partial_ledger(monkeypatch):
    """Events whose load result was lost and retried were the slow ones; a p95 without them is biased."""
    from peoplelake.evals import freshness

    full = [
        {"bucket_start_s": START_S + 10 * i, "events": 100, "published_at": (START_S + 600) * 1000} for i in range(100)
    ]
    monkeypatch.setattr(freshness, "prod_operator", lambda: FakeOperator(full))
    result = freshness.prod_freshness(DELIVERY)
    assert result["ledger_coverage"]["complete"] is True
    assert result["overall"]["events"] == 10_000

    monkeypatch.setattr(freshness, "prod_operator", lambda: FakeOperator(full[:95]))
    with pytest.raises(freshness.EvalError, match="does not hold the whole delivery"):
        freshness.prod_freshness(DELIVERY)


def test_prod_e2e_stops_at_the_quiescence_timeout_without_writing_results(monkeypatch, tmp_path):
    from peoplelake.prod import e2e as e2e_mod

    op = FakeOperator([{"bucket_start_s": START_S, "events": 99_000, "published_at": START_S * 1000}])
    monkeypatch.setattr(e2e_mod, "prod_operator", lambda: op)
    monkeypatch.setattr(e2e_mod, "deliver", lambda **kw: dict(DELIVERY, profile="full"))
    monkeypatch.setattr(e2e_mod, "repo_root", lambda: tmp_path)
    clock = iter(range(0, 10_000, 1000))
    monkeypatch.setattr(e2e_mod.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(e2e_mod.time, "sleep", lambda s: None)
    with pytest.raises(SystemExit, match="not quiescent"):
        e2e_mod.e2e(60, quiesce_timeout_s=3000)
    assert not (tmp_path / "evals").exists()
