"""`peoplelake sim deliver`: post a profile to the Worker as the three sources would.

Local: dev JWTs against wrangler dev. Production: Access service-token headers from .prod/secrets.env
against https://peoplelake.<subdomain>.workers.dev. `--mode live` paces the whole profile over
`--duration` (the production freshness measurement uses exactly one such delivery); `--mode chunk`
sends it as fast as possible. Each delivery writes a record with its id, window and counts, which
`peoplelake eval freshness --target prod --from-delivery <id>` reads.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

from ..envfile import read_env_file
from ..generator import generate, get_profile
from ..paths import data_dir, repo_root
from ..sim.client import DeliveryStats, SourceClients
from ..sim.plan import MAX_BATCH
from ..warehouse.direct import canonical_order, envelopes_from_dataset

DELIVERIES = "deliveries"


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


def deliver(*, target: str, profile: str, mode: str, duration_minutes: float) -> dict:
    items = canonical_order(envelopes_from_dataset(generate(get_profile(profile))))
    if target == "prod":
        sources, url = prod_clients()
    else:
        url = "http://127.0.0.1:8791"
        sources = SourceClients(url, local=True, keys_dir=repo_root() / ".dev" / "keys")
    delivery_id = datetime.now(UTC).strftime("d-%Y%m%dT%H%M%SZ")
    stats = DeliveryStats()
    started = datetime.now(UTC)
    t0 = time.monotonic()
    rate = len(items) / (duration_minutes * 60) if mode == "live" else None
    sent = 0
    while sent < len(items):
        target_count = len(items) if rate is None else min(len(items), int(rate * (time.monotonic() - t0)) + 1)
        if target_count > sent:
            by_source: dict[str, list[dict]] = {}
            for source, env in items[sent:target_count]:
                by_source.setdefault(source, []).append(env)
            for source, envs in by_source.items():
                for i in range(0, len(envs), MAX_BATCH):
                    sources.deliver(source, envs[i : i + MAX_BATCH], stats)
            sent = target_count
        if rate is not None:
            time.sleep(1.0)
    record = {
        "delivery_id": delivery_id,
        "target": target,
        "worker_url": url,
        "profile": profile,
        "mode": mode,
        "duration_minutes": duration_minutes if mode == "live" else None,
        "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "records": stats.records,
        "requests": stats.requests,
        "by_source": stats.by_source,
    }
    out = data_dir() / DELIVERIES / f"{delivery_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, indent=2) + "\n")
    sources.close()
    return record


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
