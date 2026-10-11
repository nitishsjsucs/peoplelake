from collections import Counter

import pytest

from peoplelake.generator import FULL, SMALL, SOURCES


@pytest.mark.smoke
def test_three_sources(ds):
    assert SOURCES == ("hris", "ats", "talent")
    assert set(ds.records) == {"hris", "ats", "talent"}


@pytest.mark.smoke
def test_exact_counts_per_source_and_type(ds):
    expected = ds.profile.expected_counts()
    for source in SOURCES:
        got = Counter(r.event_type for r in ds.records[source])
        assert dict(got) == expected[source], source


def test_totals_match_spec_table():
    assert FULL.expected_counts()["hris"] == {
        "worker.hired": 6400,
        "worker.rehired": 150,
        "worker.terminated": 1960,
        "worker.transferred": 1500,
        "worker.job_changed": 3000,
        "worker.fte_changed": 800,
        "worker.event_corrected": 600,
        "worker.event_rescinded": 60,
    }
    assert FULL.expected_counts()["ats"] == {
        "requisition.opened": 2900,
        "requisition.closed": 2700,
        "application.submitted": 30000,
        "application.stage_changed": 13530,
        "offer.extended": 3200,
        "offer.accepted": 2600,
        "offer.declined": 520,
        "offer.rescinded": 80,
    }
    assert FULL.expected_counts()["talent"] == {"compensation.changed": 19500, "review.submitted": 10500}
    for profile, totals in ((FULL, (14470, 55530, 30000, 100_000)), (SMALL, (1447, 5553, 3000, 10_000))):
        per_source = [sum(profile.expected_counts()[s].values()) for s in SOURCES]
        assert (*per_source, sum(per_source)) == totals
        assert sum(per_source) == profile.total_events


def test_manifest_counts(ds):
    m = ds.manifest()
    assert m["total_events"] == ds.profile.total_events
    assert m["data_as_of"] == "2025-12-31"
    for source in SOURCES:
        assert m["sources"][source]["event_types"] == ds.profile.expected_counts()[source]


def test_event_ids_unique_and_sequences_dense(ds):
    ids = [r.event_id for recs in ds.records.values() for r in recs]
    assert len(ids) == len(set(ids)) == ds.profile.total_events
    for recs in ds.records.values():
        assert [r.sequence for r in recs] == list(range(1, len(recs) + 1))


def test_detail_counts(ds):
    p = ds.profile
    hris = ds.envelopes("hris")
    hires = [e for e in hris if e["eventType"] == "worker.hired"]
    assert Counter(e["data"]["hire_source"] for e in hires) == {
        "initial_load": p.initial_population,
        "external": p.external_hires,
    }
    jobs = Counter(e["data"]["change_type"] for e in hris if e["eventType"] == "worker.job_changed")
    assert jobs == {"promotion": p.promotions, "lateral": p.laterals}
    fields = Counter(
        next(iter(e["data"]["corrected_fields"])) for e in hris if e["eventType"] == "worker.event_corrected"
    )
    assert fields["to_department_id"] == p.corr_transfer_dept
    assert fields["to_fte_bp"] == p.corr_fte
    assert fields["effective_date"] == p.corr_hire_date + p.corr_term_date
    reasons = Counter(e["body"]["reason"] for e in ds.envelopes("talent") if e["kind"] == "compensation.changed")
    assert reasons == {
        "initial": p.initial_population,
        "hire": p.external_hires,
        "rehire": p.rehires,
        "merit": 3 * p.merit_per_cycle,
        "promotion": p.promotions,
        "adjustment": p.adjustments,
    }
    closes = Counter(e["attributes"]["close_reason"] for e in ds.envelopes("ats") if e["type"] == "requisition.closed")
    assert closes == {"filled": p.requisitions_filled, "cancelled": p.requisitions_cancelled}
