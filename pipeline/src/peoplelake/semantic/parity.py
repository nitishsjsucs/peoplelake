"""MetricFlow parity: the semantic layer (`warehouse/models/semantic/_semantic.yml`) must answer the five
metrics exactly as the published mart `metrics_workforce_monthly` does, for every month of the window,
every department and the company (`ALL`).

MetricFlow is a dev dependency (it is not in the runner image): it only plans SQL here. The plan is
rendered for DuckDB and executed on this repo's own DuckDB connection (`open_duckdb`, UTC), so the
check needs no dbt adapter connection and no `target/` directory other than the one given.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

METRICS = ("headcount", "fte", "hires", "departures", "offers_accepted", "offers_decided", "offer_acceptance_rate")
SIX = Decimal("0.000001")


class DuckDbSqlClient:
    """The minimal MetricFlow SqlClient: DuckDB dialect, queries run on an existing connection."""

    def __init__(self, con: Any) -> None:
        from metricflow.protocols.sql_client import SqlEngine
        from metricflow.sql.render.duckdb_renderer import DuckDbSqlPlanRenderer

        self._con = con
        self._engine = SqlEngine.DUCKDB
        self._renderer = DuckDbSqlPlanRenderer()

    @property
    def sql_engine_type(self):  # noqa: ANN201 - MetricFlow's SqlEngine
        return self._engine

    @property
    def sql_plan_renderer(self):  # noqa: ANN201 - MetricFlow's SqlPlanRenderer
        return self._renderer

    def _check_no_binds(self, sql_bind_parameter_set: Any) -> None:
        if sql_bind_parameter_set is not None and getattr(sql_bind_parameter_set, "param_dict", None):
            raise ValueError("bind parameters are not used by the parity queries")

    def query(self, stmt: str, sql_bind_parameter_set: Any = None):  # noqa: ANN201
        from metricflow.data_table.mf_table import MetricFlowDataTable

        self._check_no_binds(sql_bind_parameter_set)
        cur = self._con.execute(stmt)
        names = [d[0] for d in cur.description]
        return MetricFlowDataTable.create_from_rows(column_names=names, rows=cur.fetchall())

    def execute(self, stmt: str, sql_bind_parameter_set: Any = None) -> None:
        self._check_no_binds(sql_bind_parameter_set)
        self._con.execute(stmt)

    def dry_run(self, stmt: str, sql_bind_parameter_set: Any = None) -> None:
        self._check_no_binds(sql_bind_parameter_set)
        self._con.execute(f"EXPLAIN {stmt}")

    def close(self) -> None:
        return None

    def render_bind_parameter_key(self, bind_parameter_key: str) -> str:
        return f"${bind_parameter_key}"


def load_semantic_manifest(target_path: Path):  # noqa: ANN201
    from metricflow_semantics.model.dbt_manifest_parser import parse_manifest_from_dbt_generated_manifest

    path = target_path / "semantic_manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found: run dbt parse or build with --target-path {target_path}")
    return parse_manifest_from_dbt_generated_manifest(manifest_json_string=path.read_text())


def metricflow_rows(con: Any, target_path: Path, *, by_department: bool) -> tuple[list[dict], str]:
    """The seven metrics by month (and department), planned by MetricFlow and run on `con`. Returns the
    rows and the SQL MetricFlow generated."""
    from metricflow.engine.metricflow_engine import MetricFlowEngine, MetricFlowQueryRequest
    from metricflow_semantics.model.semantic_manifest_lookup import SemanticManifestLookup

    engine = MetricFlowEngine(SemanticManifestLookup(load_semantic_manifest(target_path)), DuckDbSqlClient(con))
    group_by = ["metric_time__month", "department"] if by_department else ["metric_time__month"]
    request = MetricFlowQueryRequest.create(metric_names=list(METRICS), group_by_names=group_by)
    sql = engine.explain(request).sql_statement.sql
    result = engine.query(request).result_df
    names = list(result.column_names)
    return [dict(zip(names, row, strict=True)) for row in result.rows], sql


def _month(value: Any) -> str:
    if isinstance(value, datetime | date):
        return value.isoformat()[:7]
    return str(value)[:7]


def _int(value: Any) -> int:
    return 0 if value is None else int(value)


def _dec(value: Any) -> Decimal:
    return Decimal(0).quantize(SIX) if value is None else Decimal(str(value)).quantize(SIX, rounding=ROUND_HALF_UP)


def _rate(value: Any) -> Decimal | None:
    return None if value is None else Decimal(repr(float(value))).quantize(SIX, rounding=ROUND_HALF_UP)


@dataclass
class ParityReport:
    rows_compared: int = 0
    mismatches: list[dict] = field(default_factory=list)
    metricflow_sql_chars: int = 0

    @property
    def passed(self) -> bool:
        return self.rows_compared > 0 and not self.mismatches

    def as_dict(self) -> dict:
        return {
            "rows_compared": self.rows_compared,
            "mismatched_rows": len(self.mismatches),
            "first_mismatches": self.mismatches[:10],
            "passed": self.passed,
        }


def compare(mart: list[dict], by_department: list[dict], company: list[dict]) -> ParityReport:
    """Mart rows (month, department_id, five metrics and offer components) against MetricFlow's answers.
    Months or departments with no facts are absent from MetricFlow's output; their counts are 0 and the
    rate is null, exactly as in the mart."""
    mf: dict[tuple[str, str], dict] = {}
    for r in by_department:
        mf[(_month(r["metric_time__month"]), str(r["department"]))] = r
    for r in company:
        mf[(_month(r["metric_time__month"]), "ALL")] = r
    report = ParityReport()
    for row in mart:
        key = (_month(row["month"]), str(row["department_id"]))
        got = mf.get(key, {})
        expected = {
            "headcount": _int(row["headcount"]),
            "fte": _dec(row["fte"]),
            "hires": _int(row["hires"]),
            "departures": _int(row["departures"]),
            "offers_accepted": _int(row["offers_accepted"]),
            "offers_decided": _int(row["offers_accepted"]) + _int(row["offers_declined"]),
            "offer_acceptance_rate": None
            if row["offer_acceptance_rate"] is None
            else _dec(row["offer_acceptance_rate"]),
        }
        actual = {
            "headcount": _int(got.get("headcount")),
            "fte": _dec(got.get("fte")),
            "hires": _int(got.get("hires")),
            "departures": _int(got.get("departures")),
            "offers_accepted": _int(got.get("offers_accepted")),
            "offers_decided": _int(got.get("offers_decided")),
            "offer_acceptance_rate": _rate(got.get("offer_acceptance_rate")),
        }
        report.rows_compared += 1
        diff = {
            k: {"mart": str(expected[k]), "metricflow": str(actual[k])} for k in METRICS if expected[k] != actual[k]
        }
        if diff:
            report.mismatches.append({"month": key[0], "department_id": key[1], "diff": diff})
    return report


def mart_rows(con: Any) -> list[dict]:
    cur = con.execute(
        "select month, department_id, headcount, fte, hires, departures, offers_accepted, offers_declined, "
        "offer_acceptance_rate from pl_core.metrics_workforce_monthly order by month nulls last, department_id nulls last"
    )
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def run_parity(duckdb_path: Path, target_path: Path) -> dict:
    """Compare on a built warehouse whose `dbt parse` or `build` wrote `target_path/semantic_manifest.json`."""
    from ..warehouse.duckdb_wh import open_duckdb

    con = open_duckdb(duckdb_path)
    try:
        by_department, sql = metricflow_rows(con, target_path, by_department=True)
        company, _ = metricflow_rows(con, target_path, by_department=False)
        report = compare(mart_rows(con), by_department, company)
    finally:
        con.close()
    out = report.as_dict()
    out["metricflow_sql_sample"] = sql[:400]
    return out


def parity_report(profile: str, workdir: Path, command: str) -> dict:
    """Builds the profile straight into DuckDB (the SPEC 15.4 reference build), then compares MetricFlow
    with the mart on that warehouse."""
    import platform
    import time
    from datetime import UTC
    from datetime import datetime as dt

    from ..devtools.reference import reference_digests

    started = time.monotonic()
    reference = reference_digests(profile, workdir)
    parity = run_parity(workdir / f"reference-{profile}.duckdb", workdir / "dbt-target")
    return {
        "kind": "metricflow-parity",
        "command": command,
        "date": dt.now(UTC).strftime("%Y-%m-%d"),
        "profile": profile,
        "engine": "duckdb",
        "semantic_layer": "MetricFlow (dbt-metricflow 0.15.0, metricflow 0.213.0) planning DuckDB SQL",
        "mart": "pl_core.metrics_workforce_monthly",
        "metrics": list(METRICS),
        "events_loaded": reference["events_loaded"],
        "machine": f"{platform.system()} {platform.machine()}",
        "duration_s": round(time.monotonic() - started, 1),
        **parity,
    }


def write(result: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n")
