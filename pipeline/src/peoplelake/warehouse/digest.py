"""Engine-independent output digests (ADR 0005, SPEC 10.3).

"Identical warehouse outputs" means equal SHA-256 digests over the 10 published models. Each model
declares its business columns with a logical type and its primary key. Values are canonicalized by
logical type (not by the engine's physical type), rows are sorted by the primary key in Python, and
the JSON lines are hashed. `_pl_*` metadata, `received_at` and `delivery_id` are never declared, so
they never reach a digest. DuckDB and BigQuery outputs are therefore comparable with each other.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

import pyarrow as pa

DIGEST_VERSION = 1
Logical = Literal["string", "int", "bool", "date", "timestamp", "decimal"]
SIX_PLACES = Decimal("0.000001")


class DigestError(ValueError):
    pass


@dataclass(frozen=True)
class ModelSpec:
    name: str
    schema: str  # base dataset or schema name; a suffix may be appended (peoplelake_core_drill)
    columns: tuple[tuple[str, Logical], ...]
    primary_key: tuple[str, ...]

    @property
    def column_names(self) -> tuple[str, ...]:
        return tuple(c for c, _ in self.columns)


def _spec(name: str, schema: str, pk: tuple[str, ...], *cols: tuple[str, Logical]) -> ModelSpec:
    spec = ModelSpec(name, schema, tuple(cols), pk)
    missing = set(pk) - set(spec.column_names)
    if missing:
        raise AssertionError(f"{name}: primary key columns {missing} are not declared")
    return spec


MODEL_SPECS: dict[str, ModelSpec] = {
    s.name: s
    for s in (
        _spec(
            "dim_department",
            "peoplelake_core",
            ("department_id",),
            ("department_id", "string"),
            ("department_name", "string"),
        ),
        _spec(
            "dim_job",
            "peoplelake_core",
            ("job_code",),
            ("job_code", "string"),
            ("job_title", "string"),
            ("job_family", "string"),
            ("job_level", "int"),
        ),
        _spec(
            "dim_employee_history",
            "peoplelake_core",
            ("employee_id", "valid_from"),
            ("employee_id", "string"),
            ("spell_no", "int"),
            ("valid_from", "date"),
            ("valid_to", "date"),
            ("department_id", "string"),
            ("job_code", "string"),
            ("location_id", "string"),
            ("fte", "decimal"),
            ("employment_status", "string"),
            ("is_current", "bool"),
            ("employee_bucket", "int"),
        ),
        _spec(
            "dim_employee",
            "peoplelake_core",
            ("employee_id",),
            ("employee_id", "string"),
            ("current_spell_no", "int"),
            ("spell_count", "int"),
            ("first_hire_date", "date"),
            ("latest_hire_date", "date"),
            ("termination_date", "date"),
            ("employment_status", "string"),
            ("department_id", "string"),
            ("job_code", "string"),
            ("location_id", "string"),
            ("fte", "decimal"),
            ("is_rehire", "bool"),
        ),
        _spec(
            "fct_employment_events",
            "peoplelake_core",
            ("event_id",),
            ("event_id", "string"),
            ("employee_id", "string"),
            ("spell_no", "int"),
            ("event_kind", "string"),
            ("effective_date", "date"),
            ("department_id", "string"),
            ("previous_department_id", "string"),
            ("job_code", "string"),
            ("previous_job_code", "string"),
            ("fte", "decimal"),
            ("previous_fte", "decimal"),
            ("change_type", "string"),
            ("termination_type", "string"),
            ("is_corrected", "bool"),
        ),
        _spec(
            "fct_offers",
            "peoplelake_core",
            ("offer_id",),
            ("offer_id", "string"),
            ("requisition_id", "string"),
            ("application_id", "string"),
            ("candidate_id", "string"),
            ("department_id", "string"),
            ("job_code", "string"),
            ("extended_date", "date"),
            ("decision_date", "date"),
            ("final_status", "string"),
            ("start_date", "date"),
            ("hired_employee_id", "string"),
        ),
        _spec(
            "fct_workforce_monthly",
            "peoplelake_core",
            ("employee_id", "month_end"),
            ("employee_id", "string"),
            ("month_end", "date"),
            ("spell_no", "int"),
            ("department_id", "string"),
            ("job_code", "string"),
            ("location_id", "string"),
            ("fte", "decimal"),
            ("employee_bucket", "int"),
        ),
        _spec(
            "metrics_workforce_monthly",
            "peoplelake_core",
            ("month", "department_id"),
            ("month", "date"),
            ("department_id", "string"),
            ("headcount", "int"),
            ("fte", "decimal"),
            ("hires", "int"),
            ("rehires", "int"),
            ("departures", "int"),
            ("transfers_in", "int"),
            ("transfers_out", "int"),
            ("offers_extended", "int"),
            ("offers_accepted", "int"),
            ("offers_declined", "int"),
            ("offer_acceptance_rate", "decimal"),
        ),
        _spec(
            "fct_compensation_history",
            "peoplelake_restricted",
            ("employee_id", "valid_from"),
            ("employee_id", "string"),
            ("valid_from", "date"),
            ("valid_to", "date"),
            ("change_id", "string"),
            ("reason", "string"),
            ("base_salary", "int"),
            ("currency", "string"),
            ("bonus_target_pct", "decimal"),
            ("employee_bucket", "int"),
        ),
        _spec(
            "fct_performance_reviews",
            "peoplelake_restricted",
            ("review_id",),
            ("review_id", "string"),
            ("employee_id", "string"),
            ("cycle", "string"),
            ("review_date", "date"),
            ("rating", "int"),
            ("reviewer_id", "string"),
        ),
    )
}
PUBLISHED_MODELS: tuple[str, ...] = tuple(MODEL_SPECS)


def canon(value: Any, logical: Logical) -> str | None:
    if value is None:
        return None
    if isinstance(value, float):
        raise DigestError(f"float value {value!r} in a published model (only exact types are allowed)")
    if logical == "string":
        return str(value)
    if logical == "int":
        if isinstance(value, Decimal) and value != value.to_integral_value():
            raise DigestError(f"non-integral value {value} for an int column")
        return str(int(value))
    if logical == "bool":
        if not isinstance(value, bool):
            raise DigestError(f"non-boolean {value!r} for a bool column")
        return "true" if value else "false"
    if logical == "date":
        if isinstance(value, datetime):
            value = value.date()
        if isinstance(value, date):
            return value.isoformat()
        return date.fromisoformat(str(value)).isoformat()
    if logical == "timestamp":
        if not isinstance(value, datetime):
            value = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if logical == "decimal":
        d = Decimal(value) if not isinstance(value, Decimal) else value
        d = d.quantize(SIX_PLACES, rounding=ROUND_HALF_UP)
        if d == 0:
            d = Decimal("0.000000")
        return format(d, "f")
    raise DigestError(f"unknown logical type {logical}")


def canonical_rows(spec: ModelSpec, table: pa.Table) -> list[list[str | None]]:
    missing = [c for c in spec.column_names if c not in table.column_names]
    if missing:
        raise DigestError(f"{spec.name}: missing columns {missing}")
    cols = [table.column(name).to_pylist() for name in spec.column_names]
    rows = [
        [canon(v, logical) for v, (_, logical) in zip(values, spec.columns, strict=True)]
        for values in zip(*cols, strict=True)
    ]
    pk_idx = [spec.column_names.index(c) for c in spec.primary_key]

    def key(row: list[str | None]) -> tuple[tuple[int, str], ...]:
        return tuple((1, "") if row[i] is None else (0, row[i]) for i in pk_idx)  # NULLS LAST

    rows.sort(key=key)
    return rows


def digest_table(spec: ModelSpec, table: pa.Table) -> str:
    h = hashlib.sha256()
    h.update(f"peoplelake-digest-v{DIGEST_VERSION}\n{spec.name}\n{json.dumps(list(spec.column_names))}\n".encode())
    for row in canonical_rows(spec, table):
        h.update(json.dumps(row, separators=(",", ":"), ensure_ascii=True).encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


# The metrics snapshot the Worker serves to viewers: the mart's columns read through the suppressed
# reporting view (small cells null), never the mart itself. Digests still cover the mart.
SNAPSHOT_SPEC = ModelSpec(
    "rpt_metrics_monthly",
    "peoplelake_reporting",
    MODEL_SPECS["metrics_workforce_monthly"].columns,
    MODEL_SPECS["metrics_workforce_monthly"].primary_key,
)


def select_sql(spec: ModelSpec, schema: str) -> str:
    """Engine-neutral SELECT of the declared columns in primary key order (NULLS LAST, total order)."""
    order = ", ".join(f"{c} NULLS LAST" for c in spec.primary_key)
    return f"SELECT {', '.join(spec.column_names)} FROM {schema}.{spec.name} ORDER BY {order}"


def schema_for(spec: ModelSpec, suffix: str | None) -> str:
    return f"{spec.schema}_{suffix}" if suffix else spec.schema
