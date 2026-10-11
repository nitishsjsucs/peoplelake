"""The BigQuery drill stops before a scenario whose estimate would pass the monthly guard (SPEC 29.4.6)."""

from peoplelake.budget import BQ_MONTHLY_BYTES_CAP, BQ_TRANSFORM_RESERVE_BYTES
from peoplelake.evals.scenarios import drill_scenario_estimate_bytes, run_scenarios

GB = 1_000_000_000


def test_estimate_is_about_one_transform_per_chunk():
    assert drill_scenario_estimate_bytes(10) == 12 * BQ_TRANSFORM_RESERVE_BYTES == 36 * GB


def test_the_drill_stops_before_passing_the_monthly_guard_and_lists_what_to_resume():
    billed = {"bytes": 150 * GB}
    ran = []

    def run_one(scenario):
        ran.append(scenario)
        billed["bytes"] += 36 * GB  # each scenario bills about its estimate
        return {"scenario": scenario, "passed": True}

    results, deferred, at = run_scenarios(
        ["B", "S1", "S2", "S3", "S4", "S5"], run_one, month_billed=lambda: billed["bytes"], chunks=10
    )
    # 150 + 36 = 186, + 36 = 222, + 36 = 258 <= 275; the next would reach 294.
    assert ran == ["B", "S1", "S2"]
    assert deferred == ["S3", "S4", "S5"]
    assert at == 258 * GB
    assert [r["scenario"] for r in results] == ["B", "S1", "S2"]


def test_a_new_month_resumes_with_the_deferred_scenarios():
    results, deferred, _ = run_scenarios(
        ["S3", "S4", "S5"], lambda s: {"scenario": s}, month_billed=lambda: 0, chunks=10, cap=BQ_MONTHLY_BYTES_CAP
    )
    assert [r["scenario"] for r in results] == ["S3", "S4", "S5"] and deferred == []


def test_local_runs_have_no_guard():
    results, deferred, at = run_scenarios(["B"], lambda s: {"scenario": s})
    assert (len(results), deferred, at) == (1, [], None)
