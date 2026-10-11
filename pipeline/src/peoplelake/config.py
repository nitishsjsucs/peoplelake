"""Settings from the environment. Local defaults point at the stand-ins under .data/."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from .paths import data_dir

Target = Literal["local", "prod", "prod-drill"]


class Settings(BaseModel):
    target: Target = "local"
    profile: str = "small"
    worker_url: str = "http://127.0.0.1:8791"
    lake_dir: Path
    duckdb_path: Path
    dataset_suffix: str | None = None
    gcp_project: str | None = None
    bq_location: str = "US"
    r2_catalog_uri: str | None = None
    r2_warehouse: str | None = None
    r2_catalog_token: str | None = None
    cf_access_client_id: str | None = None
    cf_access_client_secret: str | None = None
    dev_keys_dir: Path

    @property
    def is_local(self) -> bool:
        return self.target == "local"


def load_settings(target: Target | None = None) -> Settings:
    env = os.environ
    base = data_dir()
    return Settings(
        target=target or env.get("PL_TARGET", "local"),  # type: ignore[arg-type]
        profile=env.get("PL_PROFILE", "small"),
        worker_url=env.get("PL_WORKER_URL", "http://127.0.0.1:8791"),
        lake_dir=Path(env.get("PL_LAKE_DIR", str(base / "lake"))),
        duckdb_path=Path(env.get("PL_DUCKDB_PATH", str(base / "warehouse" / "peoplelake.duckdb"))),
        dataset_suffix=env.get("PL_DATASET_SUFFIX") or None,
        gcp_project=env.get("PL_GCP_PROJECT") or None,
        bq_location=env.get("PL_BQ_LOCATION", "US"),
        r2_catalog_uri=env.get("PL_R2_CATALOG_URI") or None,
        r2_warehouse=env.get("PL_R2_WAREHOUSE") or None,
        r2_catalog_token=env.get("PL_R2_CATALOG_TOKEN") or None,
        cf_access_client_id=env.get("PL_CF_ACCESS_CLIENT_ID") or None,
        cf_access_client_secret=env.get("PL_CF_ACCESS_CLIENT_SECRET") or None,
        dev_keys_dir=Path(env.get("PL_DEV_KEYS_DIR", str(base.parent / ".dev" / "keys"))),
    )


def open_lake(settings: Settings):
    """The raw events table: local stand-in (created if absent) or Basin Catalog (sink-created)."""
    from .lake.catalog import basin_catalog, ensure_local_table, load_table, local_catalog

    if settings.is_local:
        return ensure_local_table(local_catalog(settings.lake_dir))
    missing = [
        n
        for n, v in (
            ("PL_R2_CATALOG_URI", settings.r2_catalog_uri),
            ("PL_R2_WAREHOUSE", settings.r2_warehouse),
            ("PL_R2_CATALOG_TOKEN", settings.r2_catalog_token),
        )
        if not v
    ]
    if missing:
        raise RuntimeError(f"Basin Catalog settings missing: {', '.join(missing)}")
    table = load_table(basin_catalog(settings.r2_catalog_uri, settings.r2_warehouse, settings.r2_catalog_token))  # type: ignore[arg-type]
    if table is None:
        raise RuntimeError("peoplelake.raw_events does not exist yet (the Basin sink creates it on its first roll)")
    return table
