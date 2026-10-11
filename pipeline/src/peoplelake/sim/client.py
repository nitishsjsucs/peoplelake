"""Posts source envelopes to POST /v1/ingest/:source in batches, as each simulated source would."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from ..auth.dev_tokens import AccessHeaders
from ..canonical import canonical_json
from ..runner.client import WorkerClient

SOURCE_IDENTITY = {"hris": "hris", "ats": "ats", "talent": "talent"}


@dataclass
class DeliveryStats:
    requests: int = 0
    records: int = 0
    by_source: dict[str, int] = field(default_factory=dict)


class SourceClients:
    """One Worker client per source, each authenticated as that source (a source token posts only to itself)."""

    def __init__(
        self, worker_url: str, *, local: bool, keys_dir=None, service_tokens: dict[str, tuple[str, str]] | None = None
    ) -> None:
        self.clients: dict[str, WorkerClient] = {}
        for source, identity in SOURCE_IDENTITY.items():
            if local:
                headers = AccessHeaders(local=True, identity=identity, keys_dir=keys_dir)
            else:
                cid, secret = (service_tokens or {})[source]
                headers = AccessHeaders(local=False, client_id=cid, client_secret=secret)
            self.clients[source] = WorkerClient(worker_url, headers)

    def close(self) -> None:
        for c in self.clients.values():
            c.close()

    def deliver(self, source: str, envelopes: list[dict], stats: DeliveryStats | None = None) -> dict:
        res = self.clients[source].ingest(source, [canonical_json(e) for e in envelopes])
        if stats is not None:
            stats.requests += 1
            stats.records += len(envelopes)
            stats.by_source[source] = stats.by_source.get(source, 0) + len(envelopes)
        return res


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
