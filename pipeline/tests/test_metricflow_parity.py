"""MetricFlow semantic layer: the five metrics planned by MetricFlow equal metrics_workforce_monthly."""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal

import pytest

from dbt_helpers import make_env
from peoplelake.semantic.parity import compare, run_parity


def _mart(month: str, dept: str, **kw) -> dict:
    row = {
        "month": date.fromisoformat(month),
        "department_id": dept,
        "headcount": 0,
        "fte": Decimal("0.000000"),
        "hires": 0,
        "departures": 0,
        "offers_accepted": 0,
        "offers_declined": 0,
        "offer_acceptance_rate": None,
    }
    row.update(kw)
    return row


def test_compare_treats_missing_metricflow_rows_as_zero_counts_and_null_rate() -> None:
    mart = [_mart("2023-01-01", "D01"), _mart("2023-01-01", "ALL")]
    report = compare(mart, by_department=[], company=[])
    assert report.rows_compared == 2
    assert report.passed


def test_compare_reports_each_differing_metric() -> None:
    mart = [
        _mart(
            "2024-03-01",
            "D04",
            headcount=30,
            fte=Decimal("28.500000"),
            hires=2,
            offers_accepted=2,
            offers_declined=1,
            offer_acceptance_rate=Decimal("0.666667"),
        )
    ]
    same = {
        "metric_time__month": datetime(2024, 3, 1),
        "department": "D04",
        "headcount": 30,
        "fte": 28.5,
        "hires": 2,
        "departures": None,
        "offers_accepted": 2,
        "offers_decided": 3,
        "offer_acceptance_rate": 2 / 3,
    }
    assert compare(mart, [same], []).passed
    report = compare(mart, [{**same, "hires": 3, "offer_acceptance_rate": 0.5}], [])
    assert not report.passed
    assert set(report.mismatches[0]["diff"]) == {"hires", "offer_acceptance_rate"}


@pytest.mark.dbt
def test_metricflow_equals_the_metrics_mart_on_the_small_profile(tmp_path, monkeypatch, small) -> None:
    env = make_env(tmp_path, monkeypatch, small)
    env.load(env.items)
    built = env.dbt.build()
    assert built.success, built.failed_nodes or built.exception
    manifest = json.loads((tmp_path / "target" / "semantic_manifest.json").read_text())
    assert sorted(m["name"] for m in manifest["metrics"]) == sorted(
        ["headcount", "fte", "hires", "departures", "offers_accepted", "offers_decided", "offer_acceptance_rate"]
    )
    result = run_parity(tmp_path / "wh.duckdb", tmp_path / "target")
    assert result["rows_compared"] == 468  # 36 months x (12 departments + ALL)
    assert result["mismatched_rows"] == 0, result["first_mismatches"]
    assert result["passed"]


@pytest.mark.dbt
def test_eval_oracle_command_on_a_built_warehouse(tmp_path, monkeypatch, small, capsys) -> None:
    from peoplelake.cli import main

    env = make_env(tmp_path, monkeypatch, small)
    env.load(env.items)
    assert env.dbt.build().success
    assert main(["eval", "oracle", "--profile", "small", "--duckdb", str(tmp_path / "wh.duckdb")]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["oracle_rows_mismatched"] == 0
    # The full profile's oracle cannot match a small-profile warehouse: the command must say so.
    assert main(["eval", "oracle", "--profile", "full", "--duckdb", str(tmp_path / "wh.duckdb")]) == 1
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["oracle_rows_mismatched"] == 468


def test_eval_commands_are_wired() -> None:
    from peoplelake.cli import _cmd_eval_oracle, _cmd_eval_parity, build_parser

    parser = build_parser()
    assert parser.parse_args(["eval", "oracle"]).func is _cmd_eval_oracle
    assert parser.parse_args(["eval", "parity", "--profile", "full"]).func is _cmd_eval_parity
