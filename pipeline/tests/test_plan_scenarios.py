"""Scenario delivery plans: exact perturbation counts, determinism and request limits (SPEC 16.1)."""

from collections import Counter

import pytest

from peoplelake.sim.plan import MAX_BATCH, SCENARIOS, TYPE_FIELD, build_plan

CHUNKS = {"small": 10, "full": 20}


def event_ids(plan):
    key = {"hris": "eventId", "ats": "id", "talent": "uuid"}
    return Counter(e[key[r.source]] for chunk in plan.chunks for r in chunk for e in r.envelopes)


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_every_event_delivered_and_requests_within_limits(ds, scenario):
    plan = build_plan(scenario, ds, CHUNKS[ds.profile.name])
    counts = event_ids(plan)
    assert len(counts) == ds.profile.total_events
    for chunk in plan.chunks:
        for r in chunk:
            assert 1 <= len(r.envelopes) <= MAX_BATCH
            assert all(TYPE_FIELD[r.source] in e for e in r.envelopes)


def test_baseline_and_fault_scenarios_deliver_each_event_once(ds):
    n = CHUNKS[ds.profile.name]
    for scenario in ("B", "S2", "S4", "S5"):
        plan = build_plan(scenario, ds, n)
        assert plan.deliveries == ds.profile.total_events
        assert len(plan.chunks) == n
    assert [f["run_seq"] for f in build_plan("S2", ds, n).faults] == [3, 6, 9, 5]
    assert [f["kind"] for f in build_plan("S4", ds, n).faults] == [
        "crash_after_load",
        "fail_transform_model",
        "duplicate_result",
        "skip_claim",
        "commit_step_error",
    ]


def test_s1_duplicate_counts(ds):
    p = build_plan("S1", ds, CHUNKS[ds.profile.name])
    scale = 1 if ds.profile.name == "full" else 10
    assert p.deliveries == 111_000 // scale
    counts = Counter(event_ids(p).values())
    assert counts == {1: 90_000 // scale, 2: 9_000 // scale, 3: 1_000 // scale}
    assert p.planned["duplicates_same_request"] == 3_300 // scale
    assert p.planned["duplicates_later_chunk"] + p.planned["duplicates_end_of_last_chunk"] == 7_700 // scale


def test_s1_same_request_duplicates_share_a_request(small):
    p = build_plan("S1", small, 10)
    within = sum(
        n - 1
        for chunk in p.chunks
        for r in chunk
        for n in Counter(e[{"hris": "eventId", "ats": "id", "talent": "uuid"}[r.source]] for e in r.envelopes).values()
    )
    assert within >= p.planned["duplicates_same_request"]


def test_s3_withheld_composition_and_lateness(ds):
    p = build_plan("S3", ds, CHUNKS[ds.profile.name])
    scale = 1 if ds.profile.name == "full" else 10
    assert p.deliveries == ds.profile.total_events
    assert len(p.chunks) == CHUNKS[ds.profile.name] + 1
    assert p.planned["withheld"] == 5_000 // scale
    assert p.planned["withheld_by_type"] == {
        "worker.event_corrected": 300 // scale,
        "worker.event_rescinded": 30 // scale,
        "worker.terminated": 200 // scale,
        "worker.hired": 100 // scale,
        "offer.accepted": 50 // scale,
    }
    late = sum(p.planned["late_by_chunks"].values()) + p.planned["late_overflow_to_final_chunk"]
    assert late == 3_000 // scale
    final = sum(len(r.envelopes) for r in p.chunks[-1])
    assert final == 2_000 // scale + p.planned["late_overflow_to_final_chunk"]


def test_plans_are_deterministic(small):
    for scenario in ("S1", "S3"):
        a, b = build_plan(scenario, small, 10), build_plan(scenario, small, 10)
        assert [[(r.source, len(r.envelopes)) for r in c] for c in a.chunks] == [
            [(r.source, len(r.envelopes)) for r in c] for c in b.chunks
        ]
        assert a.planned == b.planned
