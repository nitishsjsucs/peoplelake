"""`peoplelake sim deliver`: post a profile to the Worker as the three sources would.

Local: dev JWTs against wrangler dev. Production: Access service-token headers from .prod/secrets.env
against https://peoplelake.<subdomain>.workers.dev. `--mode live` paces the whole profile over
`--duration` (the production freshness measurement uses exactly one such delivery); `--mode chunk`
sends it as fast as possible. Each delivery writes a record with its id, window and counts, which
`peoplelake eval freshness --target prod --from-delivery <id>` reads. Live mode posts once per tick:
every 10 s in production (at most 50 events per request, so at most 3,080 requests for the full profile)
and every second locally unless `--tick-seconds` says otherwise. Every batch is retried after a transport
error or a 5xx within a bounded budget (sim/retry.py); the record counts each batch once and reports the
retries separately.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime

from ..envfile import read_env_file
from ..generator import generate, get_profile
from ..paths import data_dir, repo_root
from ..sim.client import DeliveryStats, SourceClients
from ..sim.plan import LOCAL_TICK_SECONDS, MAX_BATCH, PROD_TICK_SECONDS, live_ticks
from ..warehouse.direct import canonical_order, envelopes_from_dataset

DELIVERIES = "deliveries"

log = logging.getLogger("peoplelake.sim.deliver")


def prod_clients() -> tuple[SourceClients, str]:
    prod = repo_root() / ".prod"
    secrets = read_env_file(prod / "secrets.env")
    state = json.loads((prod / "state.json").read_text())
    tokens = {
        "hris": (secrets["PL_CF_HRIS_CLIENT_ID"], secrets["PL_CF_HRIS_CLIENT_SECRET"]),
        "ats": (secrets["PL_CF_ATS_CLIENT_ID"], secrets["PL_CF_ATS_CLIENT_SECRET"]),
        "talent": (secrets["PL_CF_TALENT_CLIENT_ID"], secrets["PL_CF_TALENT_CLIENT_SECRET"]),
    }
    url = f"https://peoplelake.{state['workers_subdomain']}.workers.dev"
    return SourceClients(url, local=False, service_tokens=tokens), url


def deliver(
    *, target: str, profile: str, mode: str, duration_minutes: float, tick_seconds: float | None = None
) -> dict:
    items = canonical_order(envelopes_from_dataset(generate(get_profile(profile))))
    if target == "prod":
        sources, url = prod_clients()
    else:
        url = "http://127.0.0.1:8791"
        sources = SourceClients(url, local=True, keys_dir=repo_root() / ".dev" / "keys")
    tick = tick_seconds or (PROD_TICK_SECONDS if target == "prod" else LOCAL_TICK_SECONDS)
    delivery_id = datetime.now(UTC).strftime("d-%Y%m%dT%H%M%SZ")
    stats = DeliveryStats()
    started = datetime.now(UTC)
    try:
        if mode == "live":
            send_live(sources, items, duration_minutes * 60, tick, stats)
        else:
            by_source: dict[str, list[dict]] = {}
            for source, env in items:
                by_source.setdefault(source, []).append(env)
            for source, envs in by_source.items():
                for i in range(0, len(envs), MAX_BATCH):
                    sources.deliver(source, envs[i : i + MAX_BATCH], stats)
    except Exception:
        # A batch was refused (4xx) or ran out of retries: nothing more is sent and no record is written.
        log.error("delivery %s stopped; sent so far: %s", delivery_id, json.dumps(stats.summary()))
        sources.close()
        raise
    record = {
        "delivery_id": delivery_id,
        "target": target,
        "worker_url": url,
        "profile": profile,
        "mode": mode,
        "duration_minutes": duration_minutes if mode == "live" else None,
        "tick_seconds": tick if mode == "live" else None,
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # records, requests and by_source count each accepted batch once; attempts, retries and
        # possible_duplicate_deliveries say what the retries cost (sim/retry.py).
        **stats.summary(),
    }
    out = data_dir() / DELIVERIES / f"{delivery_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2) + "\n")
    sources.close()
    return record


def send_live(
    sources: SourceClients, items: list[tuple[str, dict]], duration_s: float, tick_s: float, stats: DeliveryStats
) -> None:
    """Send tick k's requests at start + k * tick (live_ticks), never early; a late tick is sent at once."""
    start = time.monotonic()
    for k, requests in enumerate(live_ticks(items, duration_s, tick_s)):
        wait = start + k * tick_s - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        for r in requests:
            sources.deliver(r.source, r.envelopes, stats)


def load_delivery(delivery_id: str) -> dict:
    return json.loads((data_dir() / DELIVERIES / f"{delivery_id}.json").read_text())


def latest_delivery_id(target: str = "prod") -> str | None:
    folder = data_dir() / DELIVERIES
    found = (
        sorted(p.stem for p in folder.glob("d-*.json") if json.loads(p.read_text()).get("target") == target)
        if folder.exists()
        else []
    )
    return found[-1] if found else None
