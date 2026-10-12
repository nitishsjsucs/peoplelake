"""Source delivery retries (SPEC 29.4.1): transport errors and 5xx are retried with bounded, jittered
exponential backoff that honors Retry-After; every other status fails at once; a retried batch is counted
once in the delivery stats. Sleep, jitter and clocks are injected, so nothing here waits."""

from __future__ import annotations

from datetime import UTC, datetime
from email.utils import format_datetime

import httpx
import pytest

from peoplelake.runner.client import WorkerError
from peoplelake.sim.client import DeliveryStats, SourceClients
from peoplelake.sim.retry import DeliveryGaveUp, Retrier, RetryPolicy, retry_after_seconds

WALL = 1_790_812_800.0  # 2026-10-01T00:00:00Z


class FakeTime:
    """A monotonic clock that only sleeping advances, and a fixed wall clock."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.now += s

    def monotonic(self) -> float:
        return self.now


def retrier(t: FakeTime, policy: RetryPolicy | None = None, rand: float = 1.0) -> Retrier:
    return Retrier(policy or RetryPolicy(), sleep=t.sleep, rand=lambda: rand, monotonic=t.monotonic, wall=lambda: WALL)


def response(status: int, body: str = "{}", headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, text=body, headers=headers or {}, request=httpx.Request("POST", "http://w/v1"))


def script(*steps):
    """A send() that returns or raises each step in turn and counts its calls."""
    calls: list[int] = []

    def send() -> httpx.Response:
        calls.append(1)
        step = steps[min(len(calls), len(steps)) - 1]
        if isinstance(step, Exception):
            raise step
        return response(step) if isinstance(step, int) else step

    return send, calls


def test_retry_after_is_read_as_seconds_or_an_http_date():
    assert retry_after_seconds("60", WALL) == 60.0
    assert retry_after_seconds(" 0 ", WALL) == 0.0
    in_30s = format_datetime(datetime.fromtimestamp(WALL + 30, UTC), usegmt=True)
    assert retry_after_seconds(in_30s, WALL) == 30.0
    an_hour_ago = format_datetime(datetime.fromtimestamp(WALL - 3600, UTC), usegmt=True)
    assert retry_after_seconds(an_hour_ago, WALL) == 0.0
    assert retry_after_seconds(None, WALL) is None
    assert retry_after_seconds("soon", WALL) is None
    assert retry_after_seconds("-5", WALL) is None


def test_backoff_doubles_from_the_base_is_capped_and_jittered_between_half_and_full():
    p = RetryPolicy(base_delay_s=0.5, max_delay_s=30.0)
    assert [p.delay(n, 1.0, None) for n in range(1, 9)] == [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]
    assert [p.delay(n, 0.0, None) for n in range(1, 9)] == [0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 15.0]
    # Retry-After is a floor, capped; the jittered backoff still applies when it is longer.
    assert p.delay(1, 1.0, 60.0) == 60.0
    assert p.delay(1, 1.0, 10_000.0) == p.max_retry_after_s == 120.0
    assert p.delay(7, 1.0, 1.0) == 30.0


def test_transient_failures_are_retried_until_the_batch_is_accepted():
    t = FakeTime()
    send, calls = script(
        500,
        httpx.ConnectError("refused"),
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
        httpx.ReadTimeout("timed out"),
        502,
        202,
    )
    out = retrier(t).send(send)
    assert out.response.status_code == 202
    assert out.attempts == len(calls) == 6
    assert [r.reason for r in out.retries] == [
        "http_500",
        "transport:ConnectError",
        "transport:RemoteProtocolError",
        "transport:ReadTimeout",
        "http_502",
    ]
    # A connection that was never made cannot have landed the batch; the others may have.
    assert [r.may_have_landed for r in out.retries] == [True, False, True, True, True]
    assert t.sleeps == [0.5, 1.0, 2.0, 4.0, 8.0]


def test_a_503_waits_for_retry_after_in_seconds_or_as_a_date_and_never_past_the_cap():
    t = FakeTime()
    in_45s = format_datetime(datetime.fromtimestamp(WALL + 45, UTC), usegmt=True)
    refused = '{"error":"landing_backpressure","accepted":0}'
    send, _ = script(
        response(503, refused, {"retry-after": "60"}),
        response(503, refused, {"retry-after": in_45s}),
        response(503, refused, {"retry-after": "86400"}),
        202,
    )
    out = retrier(t, rand=0.0).send(send)
    assert t.sleeps == [60.0, 45.0, 120.0]
    # The Worker said it accepted none of the batch: no duplicate can come of these retries.
    assert [r.may_have_landed for r in out.retries] == [False, False, False]


@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 413, 422, 429])
def test_any_other_4xx_fails_at_once(status):
    t = FakeTime()
    send, calls = script(status, 202)
    with pytest.raises(WorkerError) as err:
        retrier(t).send(send)
    assert err.value.status == status
    assert len(calls) == 1 and t.sleeps == []


@pytest.mark.parametrize("exc", [httpx.UnsupportedProtocol("ftp"), httpx.LocalProtocolError("bad header")])
def test_a_request_the_client_built_wrong_is_not_retried(exc):
    t = FakeTime()
    send, calls = script(exc, 202)
    with pytest.raises(type(exc)):
        retrier(t).send(send)
    assert len(calls) == 1 and t.sleeps == []


def test_a_batch_gives_up_after_its_attempt_budget():
    t = FakeTime()
    send, calls = script(500)
    with pytest.raises(DeliveryGaveUp) as err:
        retrier(t, RetryPolicy(max_attempts=10)).send(send)
    assert len(calls) == err.value.attempts == 10
    assert len(t.sleeps) == len(err.value.retries) == 9
    assert err.value.last_reason == "http_500"
    assert isinstance(err.value.__cause__, WorkerError)


def test_a_batch_gives_up_rather_than_sleep_past_its_time_budget():
    t = FakeTime()
    send, calls = script(response(503, '{"accepted":0}', {"retry-after": "60"}))
    with pytest.raises(DeliveryGaveUp) as err:
        retrier(t, RetryPolicy(budget_s=100.0)).send(send)
    # 0 s: fail, wait 60; 60 s: fail, and another 60 s would end at 120 s, past the 100 s budget.
    assert len(calls) == 2 and t.sleeps == [60.0]
    assert err.value.elapsed_s == 60.0


def test_the_default_policy_is_bounded():
    p = RetryPolicy()
    assert (p.max_attempts, p.budget_s) == (10, 600.0)
    assert (p.base_delay_s, p.max_delay_s, p.max_retry_after_s) == (0.5, 30.0, 120.0)


# -- SourceClients: the retried batch is counted once ------------------------------------------------------


def envelopes(n: int) -> list[dict]:
    return [{"eventId": f"e-{i}", "n": i} for i in range(n)]


def sources(handler, t: FakeTime, policy: RetryPolicy | None = None) -> SourceClients:
    tokens = {s: ("id", "secret") for s in ("hris", "ats", "talent")}
    return SourceClients(
        "http://worker.test",
        local=False,
        service_tokens=tokens,
        transport=httpx.MockTransport(handler),
        retrier=retrier(t, policy),
    )


def test_a_batch_retried_after_it_landed_is_counted_once_and_reported_as_a_possible_duplicate():
    landed: list[bytes] = []

    def worker(request: httpx.Request) -> httpx.Response:
        landed.append(request.content)
        if len(landed) == 1:  # the Worker accepted the batch, but the answer never reached the source
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return httpx.Response(202, json={"request_id": "r", "accepted": 50})

    t = FakeTime()
    stats = DeliveryStats()
    c = sources(worker, t)
    assert c.deliver("hris", envelopes(50), stats) == {"request_id": "r", "accepted": 50}
    assert len(landed) == 2 and landed[0] == landed[1]  # the same body, sent twice
    assert (stats.requests, stats.records, stats.by_source) == (1, 50, {"hris": 50})
    assert (stats.attempts, stats.retries, stats.retried_batches) == (2, 1, 1)
    assert stats.retry_reasons == {"transport:RemoteProtocolError": 1}
    assert stats.possible_duplicate_deliveries == 50
    assert stats.retry_wait_s == 0.5


def test_refused_and_unsent_attempts_are_not_possible_duplicates():
    calls: list[int] = []

    def worker(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("connection refused")
        if len(calls) == 2:
            return httpx.Response(
                503, json={"error": "landing_backpressure", "accepted": 0}, headers={"retry-after": "1"}
            )
        return httpx.Response(202, json={"request_id": "r", "accepted": 3})

    t = FakeTime()
    stats = DeliveryStats()
    sources(worker, t).deliver("ats", envelopes(3), stats)
    assert (stats.records, stats.attempts, stats.retries, stats.possible_duplicate_deliveries) == (3, 3, 2, 0)
    assert stats.retry_reasons == {"transport:ConnectError": 1, "http_503": 1}


def test_a_batch_that_never_gets_through_stops_the_delivery_and_counts_no_records():
    t = FakeTime()
    stats = DeliveryStats()
    c = sources(lambda r: httpx.Response(500, text="Error: Network connection lost."), t, RetryPolicy(max_attempts=3))
    with pytest.raises(DeliveryGaveUp, match="talent batch of 4 not accepted after 3 attempts"):
        c.deliver("talent", envelopes(4), stats)
    assert (stats.requests, stats.records, stats.by_source) == (0, 0, {})
    assert (stats.attempts, stats.retries, stats.failed_batches) == (3, 2, 1)


def test_an_unauthorized_source_stops_at_the_first_answer():
    t = FakeTime()
    stats = DeliveryStats()
    c = sources(lambda r: httpx.Response(401, json={"error": "unauthorized"}), t)
    with pytest.raises(WorkerError):
        c.deliver("hris", envelopes(2), stats)
    assert (stats.attempts, stats.retries, stats.records, t.sleeps) == (1, 0, 0, [])


def test_the_delivery_summary_carries_the_retry_counters():
    stats = DeliveryStats()
    t = FakeTime()
    statuses = iter([500, 202, 202])
    sources(lambda r: httpx.Response(next(statuses), json={"accepted": 1}), t).deliver("hris", envelopes(1), stats)
    sources(lambda r: httpx.Response(202, json={"accepted": 2}), t).deliver("ats", envelopes(2), stats)
    assert stats.summary() == {
        "records": 3,
        "requests": 2,
        "by_source": {"hris": 1, "ats": 2},
        "attempts": 3,
        "retries": 1,
        "retried_batches": 1,
        "retry_reasons": {"http_500": 1},
        "retry_wait_s": 0.5,
        "possible_duplicate_deliveries": 1,
        "failed_batches": 0,
    }
