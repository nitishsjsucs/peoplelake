from collections import defaultdict

from peoplelake.generator.oracle import (
    acceptance_ppm,
    expected_r6_violations,
    expected_r11_violations,
    oracle_rows,
    oracle_totals,
)


def test_oracle_totals_full(full):
    t = oracle_totals(full.world)
    assert (t.headcount_start, t.headcount_end) == (4000, 4650)
    assert t.hires_in_window == 2550 and t.rehires_in_window == 150
    assert t.departures_in_window == 1900
    assert (t.offers_accepted, t.offers_declined, t.acceptance_rate) == (2600, 520, "0.833333")
    assert (t.employees, t.spells) == (6400, 6550)


def test_oracle_totals_small(small):
    t = oracle_totals(small.world)
    assert (t.headcount_start, t.headcount_end) == (400, 465)
    assert t.hires_in_window == 255 and t.departures_in_window == 190


def test_468_rows_per_profile(ds):
    rows = oracle_rows(ds.world)
    assert len(rows) == 468
    assert len({(r["month"], r["department_id"]) for r in rows}) == 468


def test_roll_forward_identities(ds):
    rows = oracle_rows(ds.world)
    start = oracle_totals(ds.world).headcount_start
    by_dept = defaultdict(list)
    for r in rows:
        by_dept[r["department_id"]].append(r)
    prev = start
    for r in by_dept["ALL"]:
        hc = int(r["headcount"])
        assert hc == prev + int(r["hires"]) - int(r["departures"])
        prev = hc
    assert prev == oracle_totals(ds.world).headcount_end
    for dept, series in by_dept.items():
        if dept == "ALL":
            continue
        for a, b in zip(series, series[1:], strict=False):
            assert int(b["headcount"]) == (
                int(a["headcount"])
                + int(b["hires"])
                - int(b["departures"])
                + int(b["transfers_in"])
                - int(b["transfers_out"])
            )


def test_all_rows_sum_departments(ds):
    rows = oracle_rows(ds.world)
    by_month = defaultdict(list)
    for r in rows:
        by_month[r["month"]].append(r)
    for month_rows in by_month.values():
        total = next(r for r in month_rows if r["department_id"] == "ALL")
        depts = [r for r in month_rows if r["department_id"] != "ALL"]
        for f in (
            "headcount",
            "hires",
            "rehires",
            "departures",
            "offers_extended",
            "offers_accepted",
            "offers_declined",
        ):
            assert int(total[f]) == sum(int(r[f]) for r in depts)


def test_acceptance_rate_rounds_half_up():
    assert acceptance_ppm(2600, 520) == 833333
    assert acceptance_ppm(1, 2) == 333333
    assert acceptance_ppm(2, 1) == 666667
    assert acceptance_ppm(0, 0) is None
    assert acceptance_ppm(1, 7) == 125000


def test_expected_r6_and_r11_are_empty(ds):
    assert expected_r6_violations(ds.world) == []
    assert expected_r11_violations(ds.world) == []
