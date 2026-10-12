"""Posts source envelopes to POST /v1/ingest/:source in batches, as each simulated source would, retrying
transient failures (sim/retry.py, SPEC 29.4.1)."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

import httpx

from ..auth.dev_tokens import AccessHeaders
from ..canonical import canonical_json
from ..runner.client import WorkerClient, ingest_body
from .retry import DeliveryGaveUp, DeliveryRefused, Retrier, Retry

SOURCE_IDENTITY = {"hris": "hris", "ats": "ats", "talent": "talent"}


@dataclass
class DeliveryStats:
    """What a delivery sent. A batch is counted once in `requests`, `records` and `by_source` when the Worker
    accepts it, however many attempts that took; `attempts` counts HTTP requests (what the Worker's request
    allowance sees). `possible_duplicate_deliveries` bounds the duplicate deliveries the retries may have
    added to the lake and the raw table: the records of every retried attempt that could have landed (all
    but connection failures and answers that accepted nothing). The warehouse merges them on event id."""

    requests: int = 0
    records: int = 0
    by_source: dict[str, int] = field(default_factory=dict)
    attempts: int = 0
    retries: int = 0
    retried_batches: int = 0
    retry_reasons: dict[str, int] = field(default_factory=dict)
    retry_wait_s: float = 0.0
    possible_duplicate_deliveries: int = 0
    failed_batches: int = 0

    def note(self, source: str, records: int, attempts: int, retries: list[Retry], *, accepted: bool) -> None:
        self.attempts += attempts
        if retries:
            self.retries += len(retries)
            self.retried_batches += 1
            for r in retries:
                self.retry_reasons[r.reason] = self.retry_reasons.get(r.reason, 0) + 1
                self.retry_wait_s += r.delay_s
            self.possible_duplicate_deliveries += records * sum(r.may_have_landed for r in retries)
        if accepted:
            self.requests += 1
            self.records += records
            self.by_source[source] = self.by_source.get(source, 0) + records
        else:
            self.failed_batches += 1

    def summary(self) -> dict:
        return {
            "records": self.records,
            "requests": self.requests,
            "by_source": dict(self.by_source),
            "attempts": self.attempts,
            "retries": self.retries,
            "retried_batches": self.retried_batches,
            "retry_reasons": dict(self.retry_reasons),
            "retry_wait_s": round(self.retry_wait_s, 3),
            "possible_duplicate_deliveries": self.possible_duplicate_deliveries,
            "failed_batches": self.failed_batches,
        }


class SourceClients:
    """One Worker client per source, each authenticated as that source (a source token posts only to itself)."""

    def __init__(
        self,
        worker_url: str,
        *,
        local: bool,
        keys_dir=None,
        service_tokens: dict[str, tuple[str, str]] | None = None,
        transport: httpx.BaseTransport | None = None,
        retrier: Retrier | None = None,
    ) -> None:
        self.retrier = retrier or Retrier()
        self.clients: dict[str, WorkerClient] = {}
        for source, identity in SOURCE_IDENTITY.items():
            if local:
                headers = AccessHeaders(local=True, identity=identity, keys_dir=keys_dir)
            else:
                cid, secret = (service_tokens or {})[source]
                headers = AccessHeaders(local=False, client_id=cid, client_secret=secret)
            self.clients[source] = WorkerClient(worker_url, headers, transport=transport)

    def close(self) -> None:
        for c in self.clients.values():
            c.close()

    def deliver(self, source: str, envelopes: list[dict], stats: DeliveryStats | None = None) -> dict:
        """Post one batch until the Worker accepts it (202), retrying transient failures; raises WorkerError
        (DeliveryRefused) on any other status and DeliveryGaveUp when the batch's retry budget runs out."""
        stats = stats if stats is not None else DeliveryStats()
        body = ingest_body(source, [canonical_json(e) for e in envelopes])
        client = self.clients[source]
        try:
            outcome = self.retrier.send(
                lambda: client.post_ingest(source, body), what=f"{source} batch of {len(envelopes)}"
            )
        except (DeliveryGaveUp, DeliveryRefused) as exc:
            stats.note(source, len(envelopes), exc.attempts, exc.retries, accepted=False)
            raise
        except Exception:
            # A request the client built wrong (sim/retry.py raises those at once).
            stats.note(source, len(envelopes), 1, [], accepted=False)
            raise
        stats.note(source, len(envelopes), outcome.attempts, outcome.retries, accepted=True)
        return outcome.response.json() if outcome.response.content else {}


def batches(items: list[tuple[str, dict]], size: int = 500) -> Iterable[tuple[str, list[dict]]]:
    """Consecutive same-source runs of at most `size` envelopes, preserving order."""
    current: list[dict] = []
    current_source: str | None = None
    for source, env in items:
        if source != current_source or len(current) >= size:
            if current:
                yield current_source, current  # type: ignore[misc]
            current, current_source = [], source
        current.append(env)
    if current:
        yield current_source, current  # type: ignore[misc]
