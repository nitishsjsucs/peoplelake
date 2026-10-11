"""Shared setup for tests that drive dbt in process against a temporary DuckDB file."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from peoplelake.warehouse.dbt_runner import DbtRunner
from peoplelake.warehouse.direct import canonical_order, envelopes_from_dataset, load_direct
from peoplelake.warehouse.duckdb_wh import DuckDBWarehouse


@dataclass
class DbtEnv:
    wh: DuckDBWarehouse
    dbt: DbtRunner
    items: list

    def load(self, items) -> None:
        load_direct(self.wh, items)


def make_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, dataset) -> DbtEnv:
    db = tmp_path / "wh.duckdb"
    monkeypatch.setenv("PL_DUCKDB_PATH", str(db))
    monkeypatch.setenv("PL_PROFILE", dataset.profile.name)
    monkeypatch.delenv("PL_DATASET_SUFFIX", raising=False)
    monkeypatch.delenv("PL_FAULT_FAIL_MODEL", raising=False)
    wh = DuckDBWarehouse(db)
    wh.ensure_raw()
    dbt = DbtRunner(target_path=tmp_path / "target")
    seeded = dbt.seed()
    assert seeded.success, seeded.exception
    return DbtEnv(wh=wh, dbt=dbt, items=canonical_order(envelopes_from_dataset(dataset)))
