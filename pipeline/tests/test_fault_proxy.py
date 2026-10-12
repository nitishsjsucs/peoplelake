"""The fault proxy behind `peoplelake eval delivery-recovery`: a tiny HTTP proxy on a Unix socket that fails
chosen ingest requests on purpose. Here the Worker is an httpx MockTransport, so nothing listens on a port."""

from __future__ import annotations

import json

import httpx
import pytest

from peoplelake.evals.delivery_recovery import DEFAULT_FAULTS, LANDS, FaultProxy, schedule_for
from peoplelake.sim.client import DeliveryStats, SourceClients
from peoplelake.sim.retry import Retrier, RetryPolicy

WORKER = "http://127.0.0.1:8791"


class Worker:
    """Accepts every batch and remembers what landed."""

    def __init__(self) -> None:
        self.landed: list[dict] = []
        self.other: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if not request.url.path.startswith("/v1/ingest/"):
            self.other.append(request.url.path)
            return httpx.Response(200, json={"ok": True})
        body = json.loads(request.content)
        self.landed.append(body)
        return httpx.Response(202, json={"request_id": "r", "accepted": len(next(iter(body.values())))})


@pytest.fixture
def started():
    proxies: list[FaultProxy] = []

    def start(schedule: dict[int, str], worker: Worker) -> FaultProxy:
        p = FaultProxy(WORKER, schedule, upstream_transport=httpx.MockTransport(worker))
        p.start()
        proxies.append(p)
        return p

    yield start
    for p in proxies:
        p.stop()


def post(proxy: FaultProxy, n: int = 3) -> httpx.Response:
    with httpx.Client(base_url=WORKER, transport=proxy.client_transport(), timeout=10) as c:
        body = {"events": [{"eventId": f"e-{i}"} for i in range(n)]}
        return c.post("/v1/ingest/hris", json=body)


def test_bursts_are_placed_at_their_share_of_the_planned_requests_on_consecutive_ordinals():
    plan = [(0.1, ["drop", "error_500"]), (0.5, ["lost_answer"]), (0.0, ["backpressure_503"])]
    assert schedule_for(1000, plan) == {100: "drop", 101: "error_500", 500: "lost_answer", 1: "backpressure_503"}
    with pytest.raises(ValueError, match="overlap"):
        schedule_for(10, [(0.5, ["drop", "drop"]), (0.6, ["error_500"])])
    with pytest.raises(ValueError, match="unknown fault"):
        schedule_for(10, [(0.5, ["teapot"])])


def test_the_default_plan_uses_every_kind_and_fits_a_small_delivery():
    kinds = {k for _, burst in DEFAULT_FAULTS for k in burst}
    assert kinds == {"drop", "error_500", "backpressure_503", "lost_answer", "error_500_after_landing"}
    schedule = schedule_for(220, DEFAULT_FAULTS)  # about the small profile's request count
    assert len(schedule) == sum(len(burst) for _, burst in DEFAULT_FAULTS) and max(schedule) < 220


@pytest.mark.parametrize(
    ("kind", "status", "landed"),
    [
        (None, 202, 1),
        ("drop", None, 0),
        ("error_500", 500, 0),
        ("backpressure_503", 503, 0),
        ("lost_answer", None, 1),
        ("error_500_after_landing", 500, 1),
    ],
)
def test_what_the_source_sees_and_what_lands_for_each_fault(started, kind, status, landed):
    worker = Worker()
    proxy = started({1: kind} if kind else {}, worker)
    if status is None:
        with pytest.raises(httpx.RemoteProtocolError):
            post(proxy)
    else:
        res = post(proxy)
        assert res.status_code == status
        if kind == "error_500":
            assert res.text == "Error: Network connection lost."
        if kind == "backpressure_503":
            assert res.json() == {"error": "landing_backpressure", "accepted": 0}
            assert res.headers["retry-after"] == "1"
    assert len(worker.landed) == landed
    assert proxy.ledger.ingest_requests == 1
    assert [(f.kind, f.records, f.landed) for f in proxy.ledger.faults] == ([(kind, 3, landed == 1)] if kind else [])


def test_other_routes_pass_through_and_take_no_ordinal(started):
    worker = Worker()
    proxy = started({1: "drop"}, worker)
    with httpx.Client(base_url=WORKER, transport=proxy.client_transport(), timeout=10) as c:
        assert c.get("/api/status").json() == {"ok": True}
    assert worker.other == ["/api/status"] and proxy.ledger.ingest_requests == 0


def test_a_delivery_through_the_proxy_lands_every_batch_and_only_the_failed_landings_twice(started):
    worker = Worker()
    schedule = {2: "drop", 3: "error_500", 5: "lost_answer", 7: "error_500_after_landing", 8: "backpressure_503"}
    proxy = started(schedule, worker)
    sleeps: list[float] = []
    sources = SourceClients(
        WORKER,
        local=False,
        service_tokens={s: ("id", "secret") for s in ("hris", "ats", "talent")},
        transport=proxy.client_transport(),
        retrier=Retrier(RetryPolicy(), sleep=sleeps.append, rand=lambda: 0.0),
    )
    stats = DeliveryStats()
    batches = [[{"eventId": f"b{b}-e{i}"} for i in range(10)] for b in range(6)]
    for batch in batches:
        sources.deliver("hris", batch, stats)
    sources.close()

    landed_ids = [e["eventId"] for body in worker.landed for e in body["events"]]
    every_id = [e["eventId"] for batch in batches for e in batch]
    assert set(landed_ids) == set(every_id)  # every event landed
    twice = {i for i in landed_ids if landed_ids.count(i) == 2}
    assert len(landed_ids) - len(set(landed_ids)) == proxy.ledger.landed_then_failed_records() == 20
    assert all(landed_ids.count(i) <= 2 for i in landed_ids) and len(twice) == 20
    assert (stats.records, stats.requests, stats.attempts, stats.retries) == (60, 6, 11, 5)
    assert proxy.ledger.ingest_requests == 11 and len(proxy.ledger.faults) == len(schedule)
    assert stats.retry_reasons == {"transport:RemoteProtocolError": 2, "http_500": 2, "http_503": 1}
    # The client cannot tell a drop from a lost answer, so its bound counts both; the 503 said accepted 0.
    assert stats.possible_duplicate_deliveries == 40 >= proxy.ledger.landed_then_failed_records()
    assert sleeps[-1] == 1.0  # the 503's Retry-After: 1
    assert {f.kind for f in proxy.ledger.faults if f.landed} == LANDS
