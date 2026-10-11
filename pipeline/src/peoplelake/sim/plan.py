"""Delivery plans for the baseline and the five scenarios (SPEC 16.1).

A plan is a list of chunks; each chunk is a list of requests (source, envelopes) delivered in order,
after which the driver forces a landing roll and waits for the run that loads it. Counts are for the full
profile and scale by 1/10 for the small profile; run numbers and file counts stay the same. Requests carry
at most MAX_BATCH envelopes in every environment (the Worker's 50-event limit, SPEC 29.4.2), so tests
and production share one request shape; output digests do not depend on the batch size.

`live_ticks` is the live-mode schedule (`sim deliver --mode live`, the freshness eval, `prod:e2e`): the
events due in each tick, sent as one request per source per 50 events. Production sources post every
10 s, so a 60-minute delivery of the full profile makes at most 100,000 / 50 + 360 x 3 = 3,080 requests.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from ..contracts import MAX_BATCH_EVENTS
from ..generator import Dataset
from ..prng import SplitMix64
from ..warehouse.direct import canonical_order, envelopes_from_dataset

SCENARIOS: tuple[str, ...] = ("B", "S1", "S2", "S3", "S4", "S5")
SCENARIO_NAMES = {
    "B": "baseline",
    "S1": "duplicate-client-retries",
    "S2": "duplicate-lake-redelivery",
    "S3": "late-arrival",
    "S4": "recovery-step-failures",
    "S5": "recovery-warehouse-rebuild",
}
MAX_BATCH = MAX_BATCH_EVENTS
PROD_TICK_SECONDS = 10.0
LOCAL_TICK_SECONDS = 1.0
SEED = 20261010
TYPE_FIELD = {"hris": "eventType", "ats": "type", "talent": "kind"}


@dataclass
class Request:
    source: str
    envelopes: list[dict]


@dataclass
class Plan:
    scenario: str
    profile: str
    chunks: list[list[Request]]
    faults: list[dict] = field(default_factory=list)
    planned: dict = field(default_factory=dict)

    @property
    def deliveries(self) -> int:
        return sum(len(r.envelopes) for chunk in self.chunks for r in chunk)

    def requests(self) -> int:
        return sum(len(chunk) for chunk in self.chunks)


def scale(profile: str, full_count: int) -> int:
    return full_count if profile == "full" else full_count // 10


def chunk_bounds(n_items: int, n_chunks: int) -> list[tuple[int, int]]:
    return [((i - 1) * n_items // n_chunks, i * n_items // n_chunks) for i in range(1, n_chunks + 1)]


def _batches(entries: list[tuple[str, list[dict]]]) -> list[Request]:
    """Each source sends its own events in order, in requests of at most MAX_BATCH envelopes; requests of
    the three sources alternate. An entry is an original envelope plus any same-request duplicates and is
    never split across requests."""
    per_source: dict[str, list[Request]] = {}
    for source, group in entries:
        reqs = per_source.setdefault(source, [])
        if reqs and len(reqs[-1].envelopes) + len(group) <= MAX_BATCH:
            reqs[-1].envelopes.extend(group)
        else:
            reqs.append(Request(source, list(group)))
    out: list[Request] = []
    queues = [per_source[s] for s in ("hris", "ats", "talent") if s in per_source]
    for i in range(max((len(q) for q in queues), default=0)):
        out += [q[i] for q in queues if i < len(q)]
    return out


def live_ticks(items: list[tuple[str, dict]], duration_s: float, tick_s: float) -> list[list[Request]]:
    """Live delivery schedule: tick k carries items [k*n/T, (k+1)*n/T) for T = ceil(duration / tick), each
    source's events in order in requests of at most MAX_BATCH (sources alternate by first appearance)."""
    n_ticks = max(1, math.ceil(duration_s / tick_s))
    ticks: list[list[Request]] = []
    for k in range(n_ticks):
        by_source: dict[str, list[dict]] = {}
        for source, env in items[k * len(items) // n_ticks : (k + 1) * len(items) // n_ticks]:
            by_source.setdefault(source, []).append(env)
        ticks.append(
            [
                Request(s, envs[i : i + MAX_BATCH])
                for s, envs in by_source.items()
                for i in range(0, len(envs), MAX_BATCH)
            ]
        )
    return ticks


def _baseline_chunks(items: list[tuple[str, dict]], n_chunks: int) -> list[list[Request]]:
    return [_batches([(s, [e]) for s, e in items[a:b]]) for a, b in chunk_bounds(len(items), n_chunks)]


def build_plan(scenario: str, ds: Dataset, n_chunks: int) -> Plan:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario}")
    profile = ds.profile.name
    items = canonical_order(envelopes_from_dataset(ds))
    rng = SplitMix64(SEED).fork(f"scenario:{scenario}:{profile}")
    if scenario in ("B", "S5"):
        return Plan(scenario, profile, _baseline_chunks(items, n_chunks), planned={"deliveries": len(items)})
    if scenario == "S2":
        faults = [{"run_seq": r, "kind": "rewind_watermark", "snapshots": 2} for r in (3, 6, 9)]
        faults.append({"run_seq": 5, "kind": "recommit_sink_files", "count": 3})
        return Plan(
            scenario,
            profile,
            _baseline_chunks(items, n_chunks),
            faults,
            {"deliveries": len(items), "faults": len(faults)},
        )
    if scenario == "S4":
        faults = [
            {"run_seq": 2, "kind": "crash_after_load"},
            {"run_seq": 4, "kind": "fail_transform_model", "model": "fct_workforce_monthly", "attempt": 1},
            {"run_seq": 5, "kind": "duplicate_result"},
            {"run_seq": 6, "kind": "skip_claim"},
            {"run_seq": 7, "kind": "commit_step_error"},
        ]
        return Plan(
            scenario,
            profile,
            _baseline_chunks(items, n_chunks),
            faults,
            {"deliveries": len(items), "faults": len(faults)},
        )
    if scenario == "S1":
        return _duplicates_plan(items, n_chunks, profile, rng)
    return _late_plan(items, n_chunks, profile, rng)


def _duplicates_plan(items: list[tuple[str, dict]], n_chunks: int, profile: str, rng: SplitMix64) -> Plan:
    """S1: 10,000 events re-delivered once and 1,000 of them a third time; 30% of duplicate deliveries go in
    the same request as the original, 70% at least one chunk later."""
    n_second, n_third = scale(profile, 10_000), scale(profile, 1_000)
    bounds = chunk_bounds(len(items), n_chunks)
    chunk_of = [0] * len(items)
    for c, (a, b) in enumerate(bounds):
        for i in range(a, b):
            chunk_of[i] = c
    second = rng.sample(range(len(items)), n_second)
    third = rng.sample(second, n_third)
    dups = second + third  # one entry per duplicate delivery
    n_same = (len(dups) * 3) // 10
    order = list(range(len(dups)))
    rng.shuffle(order)
    same_request = Counter(dups[k] for k in order[:n_same])
    later: dict[int, list[int]] = {}
    in_last_chunk = 0
    for k in order[n_same:]:
        i = dups[k]
        if chunk_of[i] == n_chunks - 1:
            target = n_chunks - 1  # nothing later exists: a separate request at the end of the last chunk
            in_last_chunk += 1
        else:
            target = rng.randint(chunk_of[i] + 1, n_chunks - 1)
        later.setdefault(target, []).append(i)
    chunks: list[list[Request]] = []
    for c, (a, b) in enumerate(bounds):
        entries = [(items[i][0], [items[i][1]] * (1 + same_request.get(i, 0))) for i in range(a, b)]
        requests = _batches(entries)
        late = sorted(later.get(c, []))
        requests += _batches([(items[i][0], [items[i][1]]) for i in late])
        chunks.append(requests)
    planned = {
        "deliveries": len(items) + len(dups),
        "events_delivered_twice_or_more": n_second,
        "events_delivered_three_times": n_third,
        "duplicate_deliveries": len(dups),
        "duplicates_same_request": n_same,
        "duplicates_later_chunk": len(dups) - n_same - in_last_chunk,
        "duplicates_end_of_last_chunk": in_last_chunk,
    }
    return Plan("S1", profile, chunks, planned=planned)


def _late_plan(items: list[tuple[str, dict]], n_chunks: int, profile: str, rng: SplitMix64) -> Plan:
    """S3: 5,000 events withheld (exactly 300 corrections, 30 rescinds, 200 terminations, 100 hires and 50
    accepted offers); 3,000 delivered 1 to 3 chunks late, 2,000 after everything else; every request shuffled."""
    quotas = {
        "worker.event_corrected": scale(profile, 300),
        "worker.event_rescinded": scale(profile, 30),
        "worker.terminated": scale(profile, 200),
        "worker.hired": scale(profile, 100),
        "offer.accepted": scale(profile, 50),
    }
    total = scale(profile, 5_000)
    n_late, n_last = scale(profile, 3_000), scale(profile, 2_000)
    by_type: dict[str, list[int]] = {}
    for i, (source, env) in enumerate(items):
        by_type.setdefault(env[TYPE_FIELD[source]], []).append(i)
    withheld: list[int] = []
    for event_type, n in quotas.items():
        withheld += rng.sample(by_type[event_type], n)
    others = [i for t, idx in by_type.items() if t not in quotas for i in idx]
    withheld += rng.sample(others, total - len(withheld))
    rng.shuffle(withheld)
    late, last = withheld[:n_late], withheld[n_late : n_late + n_last]
    bounds = chunk_bounds(len(items), n_chunks)
    chunk_of = {}
    for c, (a, b) in enumerate(bounds):
        for i in range(a, b):
            chunk_of[i] = c
    destination: dict[int, list[int]] = {}
    lateness = Counter()
    overflow = 0
    for i in late:
        k = rng.randint(1, 3)
        target = chunk_of[i] + k
        if target >= n_chunks:
            target = n_chunks  # the final chunk after everything else
            overflow += 1
        else:
            lateness[k] += 1
        destination.setdefault(target, []).append(i)
    destination.setdefault(n_chunks, []).extend(last)
    held = set(withheld)
    chunks: list[list[Request]] = []
    for c in range(n_chunks + 1):
        indexes = [i for i in range(*bounds[c]) if i not in held] if c < n_chunks else []
        indexes += sorted(destination.get(c, []))
        rng.shuffle(indexes)
        by_source: dict[str, list[dict]] = {}
        for i in indexes:
            by_source.setdefault(items[i][0], []).append(items[i][1])
        requests = [
            Request(s, envs[j : j + MAX_BATCH]) for s, envs in by_source.items() for j in range(0, len(envs), MAX_BATCH)
        ]
        rng.shuffle(requests)
        chunks.append(requests)
    planned = {
        "deliveries": len(items),
        "withheld": len(withheld),
        "withheld_by_type": {t: n for t, n in quotas.items()},
        "late_by_chunks": {str(k): lateness[k] for k in sorted(lateness)},
        "late_overflow_to_final_chunk": overflow,
        "delivered_after_everything_else": n_last,
        "chunks": n_chunks + 1,
    }
    return Plan("S3", profile, chunks, planned=planned)
