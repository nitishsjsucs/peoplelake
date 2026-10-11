"""SPEC 5.3 world rules, asserted on the emitted envelopes for both profiles."""

from collections import Counter, defaultdict
from datetime import date

import pytest

from sourceview import BUSINESS, D, view

END_TS = "2025-12-31T23:59:59Z"
WINDOW = (D("2023-01-01"), D("2025-12-31"))


@pytest.fixture(scope="module")
def views():
    from conftest import dataset

    return {p: view(dataset(p)) for p in ("small", "full")}


@pytest.fixture(params=["small", "full"])
def v(request, views):
    return views[request.param]


@pytest.fixture(params=["small", "full"])
def pv(request, views):
    from conftest import dataset

    return dataset(request.param).profile, views[request.param]


def spells(v):
    """worker -> [(start, end_or_None)] from corrected, non-rescinded business events."""
    out = defaultdict(list)
    for worker, events in v.business_by_worker.items():
        for e in sorted(events, key=lambda e: e.corrected_effective):
            if e.event_type in ("worker.hired", "worker.rehired"):
                out[worker].append([e.corrected_effective, None])
            elif e.event_type == "worker.terminated" and e.rescinded_by is None:
                out[worker][-1][1] = e.corrected_effective
    return out


def active_spell(sp, worker, day):
    for start, end in sp[worker]:
        if start <= day and (end is None or day <= end):
            return start, end
    return None


def test_one_business_event_per_worker_per_day(v):
    for events in v.business_by_worker.values():
        orig = [e.effective for e in events]
        corr = [e.corrected_effective for e in events]
        assert len(orig) == len(set(orig))
        assert len(corr) == len(set(corr))


def test_corrected_dates_stay_between_neighbours(v):
    for events in v.business_by_worker.values():
        by_orig = [e.event_id for e in sorted(events, key=lambda e: e.effective)]
        by_corr = [e.event_id for e in sorted(events, key=lambda e: e.corrected_effective)]
        assert by_orig == by_corr


def test_hire_date_corrections(pv):
    profile, v = pv
    decisions = {}
    starts = {}
    offer_candidate = {}
    for e in v.ats:
        if e["type"] == "offer.extended":
            offer_candidate[e["attributes"]["offer_id"]] = e["attributes"]["candidate_id"]
    for e in v.ats:
        if e["type"] == "offer.accepted":
            cand = offer_candidate[e["attributes"]["offer_id"]]
            decisions[cand] = D(e["effective_on"])
            starts[cand] = D(e["attributes"]["start_date"])
    corrected = [
        e
        for e in v.hris
        if e.correction
        and e.event_type in ("worker.hired", "worker.rehired")
        and "effective_date" in e.correction.data["corrected_fields"]
    ]
    assert len(corrected) == profile.corr_hire_date
    crossing = 0
    for e in corrected:
        assert e.data["hire_source"] in ("external", "rehire")
        shift = abs(e.corrected_effective - e.effective)
        assert 1 <= shift <= 20
        cand = e.data["ats_candidate_id"]
        assert e.corrected_effective > decisions[cand]
        assert starts[cand] == e.effective  # the offer start equals the original recorded hire date
        o, t = date.fromordinal(e.effective), date.fromordinal(e.corrected_effective)
        crossing += (o.year, o.month) != (t.year, t.month)
    assert crossing == profile.corr_hire_date_cross_month


def test_termination_corrections_respect_talent_and_hris_events(pv):
    profile, v = pv
    talent_days = defaultdict(list)
    for e in v.talent:
        talent_days[e["subject"]].append(D(e["asOf"]))
    corrected = [e for e in v.hris if e.event_type == "worker.terminated" and e.correction]
    assert len(corrected) == profile.corr_term_date
    for term in corrected:
        lo = min(term.effective, term.corrected_effective)
        hi = max(term.effective, term.corrected_effective)
        events = sorted(v.business_by_worker[term.worker], key=lambda e: e.corrected_effective)
        start = max(
            e.corrected_effective
            for e in events
            if e.event_type in ("worker.hired", "worker.rehired") and e.corrected_effective < lo
        )
        for e in events:
            if e is not term and start <= e.corrected_effective <= hi:
                assert e.corrected_effective < lo and e.effective < lo
        for day in talent_days[term.worker]:
            if start <= day <= hi:
                assert day < lo


def test_value_corrections_change_the_value(v):
    for e in v.hris:
        if e.correction is None:
            continue
        fields = e.correction.data["corrected_fields"]
        if "to_department_id" in fields:
            assert e.event_type == "worker.transferred"
            assert fields["to_department_id"] not in (e.data["to_department_id"], e.data["from_department_id"])
        if "to_fte_bp" in fields:
            assert e.event_type == "worker.fte_changed"
            assert fields["to_fte_bp"] not in (e.data["to_fte_bp"], e.data["from_fte_bp"])


def test_corrections_and_rescinds_recorded_after_their_targets(v):
    for e in v.hris:
        if e.event_type == "worker.event_corrected":
            target = v.by_id[e.data["corrects_event_id"]]
            lag = D(e.recorded[:10]) - D(target.recorded[:10])
            assert 1 <= lag <= 60
            assert e.sequence > target.sequence
        elif e.event_type == "worker.event_rescinded":
            target = v.by_id[e.data["rescinds_event_id"]]
            assert target.event_type == "worker.terminated"
            lag = D(e.recorded[:10]) - D(target.recorded[:10])
            assert 1 <= lag <= 30


def test_no_correction_chains(v):
    corrected_ids = [e.data["corrects_event_id"] for e in v.hris if e.event_type == "worker.event_corrected"]
    assert len(corrected_ids) == len(set(corrected_ids))
    for target_id in corrected_ids:
        assert v.by_id[target_id].event_type in BUSINESS


def test_everything_recorded_by_data_as_of(v):
    assert all(e.recorded <= END_TS for e in v.hris)
    assert all(e["occurred_at"] <= END_TS for e in v.ats)
    assert all(e["updated"] <= END_TS for e in v.talent)


def test_ats_events_dated_in_window(v):
    for e in v.ats:
        assert WINDOW[0] <= D(e["effective_on"]) <= WINDOW[1]


def test_window_dates_for_activity(v):
    for e in v.hris:
        if e.event_type == "worker.hired" and e.data["hire_source"] == "initial_load":
            assert D("2012-01-01") <= e.effective <= D("2022-12-31")
            assert e.data["ats_candidate_id"] is None
        elif e.event_type in ("worker.hired", "worker.rehired"):
            assert e.data["ats_candidate_id"] is not None
            assert D("2023-02-01") <= min(e.effective, e.corrected_effective)
            assert max(e.effective, e.corrected_effective) <= WINDOW[1]
        elif e.event_type in BUSINESS:
            assert WINDOW[0] <= e.effective <= WINDOW[1]
            assert WINDOW[0] <= e.corrected_effective <= WINDOW[1]


def test_rehires_follow_terminations_by_90_days(v):
    sp = spells(v)
    for e in v.hris:
        if e.event_type == "worker.rehired":
            assert e.data["spell_no"] == 2
            prior = [s for s in sp[e.worker] if s[0] < e.corrected_effective]
            assert len(prior) == 1 and prior[0][1] is not None
            assert e.corrected_effective - prior[0][1] >= 90
            assert e.effective - prior[0][1] >= 90


def test_recruiting_timeline(pv):
    profile, v = pv
    opened, closed, extended = {}, Counter(), {}
    accepted = []
    for e in v.ats:
        a = e["attributes"]
        if e["type"] == "requisition.opened":
            opened[a["requisition_id"]] = D(e["effective_on"])
        elif e["type"] == "requisition.closed" and a["close_reason"] == "filled":
            closed[a["requisition_id"]] += 1
        elif e["type"] == "offer.extended":
            extended[a["offer_id"]] = a
        elif e["type"] == "offer.accepted":
            accepted.append(e)
    assert len(accepted) == profile.offers_accepted
    filled_by_offer = Counter()
    pending = 0
    for e in accepted:
        ext = extended[e["attributes"]["offer_id"]]
        start = D(e["attributes"]["start_date"])
        decision = D(e["effective_on"])
        assert 14 <= start - decision <= 45
        assert 30 <= start - opened[ext["requisition_id"]] <= 90
        assert D(ext["proposed_start_date"]) == start
        filled_by_offer[ext["requisition_id"]] += 1
        pending += start > WINDOW[1]
    assert pending == profile.pending_starts
    assert all(n == 1 for n in filled_by_offer.values())
    assert set(filled_by_offer) == set(closed) and all(n == 1 for n in closed.values())


def test_talent_uses_true_hire_dates_and_tenure_rules(v):
    sp = spells(v)
    comp_days = defaultdict(list)
    for e in v.talent:
        if e["kind"] == "compensation.changed":
            comp_days[e["subject"]].append((D(e["asOf"]), e["body"]["reason"]))
    for worker, days in comp_days.items():
        assert len({d for d, _ in days}) == len(days), f"two compensation changes on one day for {worker}"
    for e in v.hris:
        if e.event_type in ("worker.hired", "worker.rehired"):
            reason = {"initial_load": "initial", "external": "hire", "rehire": "rehire"}[e.data["hire_source"]]
            assert (e.corrected_effective, reason) in comp_days[e.worker]
        if e.event_type == "worker.job_changed" and e.data["change_type"] == "promotion":
            assert (e.effective, "promotion") in comp_days[e.worker]
    for e in v.talent:
        day = D(e["asOf"])
        span = active_spell(sp, e["subject"], day)
        assert span is not None
        if e["kind"] == "compensation.changed" and e["body"]["reason"] == "merit":
            assert date.fromordinal(day).strftime("%m-%d") == "04-01"
            assert day - span[0] >= 90
        if e["kind"] == "review.submitted":
            assert date.fromordinal(day).strftime("%m-%d") == "12-15"
            assert day - span[0] >= 180
            assert e["body"]["reviewer_id"] != e["subject"]
            assert 1 <= e["body"]["rating"] <= 5


def test_fte_values_are_basis_points(v):
    allowed = {10000, 8000, 6000, 5000}
    for e in v.hris:
        if e.event_type in ("worker.hired", "worker.rehired"):
            assert e.data["fte_bp"] in allowed
        if e.event_type == "worker.fte_changed":
            assert {e.data["from_fte_bp"], e.corrected_data["to_fte_bp"]} <= allowed
