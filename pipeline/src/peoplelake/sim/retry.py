"""Bounded retries for source deliveries (SPEC 29.4.1).

A source retries a batch after a transport error or any 5xx (503 `landing_backpressure` included), waiting
an exponential backoff with jitter, and at least the response's Retry-After (delta seconds or an HTTP date,
capped). Any other status fails at once: 400, 401, 403, 404, 413, 422 and 429 mean the batch or the
credentials are wrong, or a daily allowance is spent, and repeating the request cannot help. A batch gets
at most `max_attempts` attempts and never sleeps past `budget_s` from its first attempt; then it raises
`DeliveryGaveUp` and the delivery stops.

Retrying is safe: the Worker mints a new `delivery_id` for every record of every request, and the warehouse
keeps the first delivery of each event id (ADR 0001, scenario S1). A retry after a request that landed but
whose answer was lost therefore adds a duplicate delivery to the lake and the raw table and changes no
published row; `Retry.may_have_landed` marks the attempts that could have done so.
"""

from __future__ import annotations

import json
import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC
from email.utils import parsedate_to_datetime

import httpx

from ..runner.client import WorkerError

log = logging.getLogger("peoplelake.sim.retry")

ACCEPTED = (200, 202)

# Transient transport failures. Errors the client makes itself (UnsupportedProtocol, LocalProtocolError,
# ProxyError, InvalidURL) are bugs or configuration and are raised at once.
RETRYABLE_TRANSPORT: tuple[type[Exception], ...] = (
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.RemoteProtocolError,
)
# The request never reached the Worker, so the batch cannot have landed.
NOT_SENT: tuple[type[Exception], ...] = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


@dataclass(frozen=True)
class RetryPolicy:
    """At most 10 attempts per batch, never sleeping past 10 minutes from its first attempt (an attempt in
    flight is bounded only by the client's per-phase 60 s httpx timeouts for connect, read, write and pool,
    not by a total duration); backoff 0.5 s doubling to 30 s, jittered between
    half and all of it; Retry-After honored up to 120 s (the Worker's backpressure answer says 60)."""

    max_attempts: int = 10
    base_delay_s: float = 0.5
    max_delay_s: float = 30.0
    max_retry_after_s: float = 120.0
    budget_s: float = 600.0

    def delay(self, retry: int, rand: float, retry_after: float | None) -> float:
        """Seconds to wait before retry number `retry` (1-based), `rand` in [0, 1)."""
        ceiling = min(self.max_delay_s, self.base_delay_s * 2 ** (retry - 1))
        backoff = ceiling * (0.5 + 0.5 * rand)
        if retry_after is None:
            return backoff
        return max(backoff, min(retry_after, self.max_retry_after_s))


def retry_after_seconds(value: str | None, now: float) -> float | None:
    """Retry-After as delta seconds or an HTTP date (RFC 9110 10.2.3), relative to the wall clock `now`."""
    if value is None:
        return None
    v = value.strip()
    if v.isascii() and v.isdigit():
        # str.isdigit alone accepts non-ASCII digits that int() rejects; very long values are clamped (the
        # policy caps the wait at max_retry_after_s anyway) so int() and float() can never raise.
        return float(int(v)) if len(v) <= 9 else 1e9
    try:
        when = parsedate_to_datetime(v)
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        return max(0.0, when.timestamp() - now)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None


@dataclass(frozen=True)
class Retry:
    attempt: int  # the attempt that failed, 1-based
    reason: str  # http_<status> or transport:<exception class>
    may_have_landed: bool  # False only when the request never reached the Worker or it accepted none of it
    delay_s: float


@dataclass
class Outcome:
    response: httpx.Response
    attempts: int
    retries: list[Retry] = field(default_factory=list)


class DeliveryGaveUp(RuntimeError):
    def __init__(self, what: str, attempts: int, elapsed_s: float, last_reason: str, retries: list[Retry]) -> None:
        super().__init__(
            f"{what} not accepted after {attempts} attempts in {elapsed_s:.1f} s (last: {last_reason}); "
            "the delivery stops here"
        )
        self.attempts = attempts
        self.elapsed_s = elapsed_s
        self.last_reason = last_reason
        self.retries = retries


class DeliveryRefused(WorkerError):
    """A status no retry can fix (any 4xx, or anything else that is neither accepted nor a 5xx)."""

    def __init__(self, status: int, body: str, attempts: int, retries: list[Retry]) -> None:
        super().__init__(status, body)
        self.attempts = attempts
        self.retries = retries


def _refused_all(res: httpx.Response) -> bool:
    """The Worker answered that it accepted none of the batch (503 landing_backpressure says accepted: 0)."""
    try:
        body = json.loads(res.content)
    except ValueError:
        return False
    return isinstance(body, dict) and body.get("accepted") == 0


@dataclass
class Retrier:
    """Sends one batch with retries. Sleep, jitter and clocks are injectable for deterministic tests."""

    policy: RetryPolicy = field(default_factory=RetryPolicy)
    sleep: Callable[[float], None] = time.sleep
    rand: Callable[[], float] = random.random
    monotonic: Callable[[], float] = time.monotonic
    wall: Callable[[], float] = time.time

    def send(self, send: Callable[[], httpx.Response], what: str = "batch") -> Outcome:
        start = self.monotonic()
        retries: list[Retry] = []
        attempt = 0
        while True:
            attempt += 1
            retry_after: float | None = None
            try:
                res = send()
            except RETRYABLE_TRANSPORT as exc:
                failure: Exception = exc
                reason = f"transport:{type(exc).__name__}"
                may_have_landed = not isinstance(exc, NOT_SENT)
            else:
                if res.status_code in ACCEPTED:
                    return Outcome(res, attempt, retries)
                if not 500 <= res.status_code <= 599:
                    raise DeliveryRefused(res.status_code, res.text, attempt, retries)
                failure = WorkerError(res.status_code, res.text)
                reason = f"http_{res.status_code}"
                may_have_landed = not _refused_all(res)
                retry_after = retry_after_seconds(res.headers.get("retry-after"), self.wall())
            elapsed = self.monotonic() - start
            delay = self.policy.delay(len(retries) + 1, self.rand(), retry_after)
            if attempt >= self.policy.max_attempts or elapsed + delay > self.policy.budget_s:
                raise DeliveryGaveUp(what, attempt, elapsed, reason, retries) from failure
            retries.append(Retry(attempt, reason, may_have_landed, delay))
            log.warning(
                "%s: attempt %d of %d failed (%s%s); retrying in %.2f s",
                what,
                attempt,
                self.policy.max_attempts,
                reason,
                ", may have landed" if may_have_landed else "",
                delay,
            )
            self.sleep(delay)
