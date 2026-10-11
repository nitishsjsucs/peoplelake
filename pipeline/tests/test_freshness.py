"""Freshness summary math shared with the Worker's /api/freshness (nearest rank on weighted values)."""

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
