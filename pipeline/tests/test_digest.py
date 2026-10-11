from datetime import UTC, date, datetime
from decimal import Decimal

import pyarrow as pa
import pytest

from peoplelake.warehouse.digest import (
    MODEL_SPECS,
    PUBLISHED_MODELS,
    DigestError,
    ModelSpec,
    canon,
    digest_table,
    select_sql,
)
from peoplelake.warehouse.duckdb_wh import open_duckdb

SPEC = ModelSpec(
    name="tiny",
    schema="pl_core",
    columns=(
        ("id", "string"),
        ("n", "int"),
        ("d", "date"),
        ("ts", "timestamp"),
        ("amount", "decimal"),
        ("flag", "bool"),
    ),
    primary_key=("id",),
)
# Pinned so any change to canonicalization is deliberate (bump DIGEST_VERSION).
TINY_DIGEST = "1609d132f695c28a88327fe73279fc780534823ea42ad60889d4aef861ddd732"


def duckdb_table() -> pa.Table:
    con = open_duckdb(":memory:")
    try:
        return con.execute(
            """
            SELECT * FROM (VALUES
              ('b', CAST(2 AS BIGINT), DATE '2024-02-29', TIMESTAMPTZ '2024-02-29 23:59:59.5+00', CAST(1.5 AS DECIMAL(18,6)), false, 'x'),
              ('a', CAST(1 AS BIGINT), DATE '2023-01-01', TIMESTAMPTZ '2023-01-01 00:00:00+00', CAST(3987.6 AS DECIMAL(18,6)), true, 'y'),
              ('c', NULL, NULL, NULL, NULL, NULL, 'z')
            ) t(id, n, d, ts, amount, flag, _pl_load_seq)
            """
        ).to_arrow_table()
    finally:
        con.close()


def bigquery_shaped_table() -> pa.Table:
    """Same rows as BigQuery returns them: NUMERIC as decimal128(38, 9), INT64, other column and row order."""
    return pa.table(
        {
            "flag": pa.array([None, True, False], pa.bool_()),
            "amount": pa.array([None, Decimal("3987.600000000"), Decimal("1.500000000")], pa.decimal128(38, 9)),
            "ts": pa.array(
                [None, datetime(2023, 1, 1, tzinfo=UTC), datetime(2024, 2, 29, 23, 59, 59, 500000, tzinfo=UTC)],
                pa.timestamp("us", tz="UTC"),
            ),
            "d": pa.array([None, date(2023, 1, 1), date(2024, 2, 29)], pa.date32()),
            "n": pa.array([None, 1, 2], pa.int64()),
            "id": pa.array(["c", "a", "b"]),
            "_pl_loaded_at": pa.array(["m1", "m2", "m3"]),
        }
    )


def test_duckdb_and_bigquery_shapes_digest_identically():
    assert digest_table(SPEC, duckdb_table()) == digest_table(SPEC, bigquery_shaped_table())


def test_tiny_fixture_digest_is_pinned():
    assert digest_table(SPEC, duckdb_table()) == TINY_DIGEST


def test_row_and_column_order_and_metadata_do_not_matter():
    t = duckdb_table()
    shuffled = t.take([2, 0, 1]).select(["flag", "ts", "id", "amount", "d", "n"])
    assert digest_table(SPEC, shuffled) == digest_table(SPEC, t)
    changed_meta = t.set_column(t.column_names.index("_pl_load_seq"), "_pl_load_seq", pa.array(["q", "r", "s"]))
    assert digest_table(SPEC, changed_meta) == digest_table(SPEC, t)


def test_value_change_changes_digest():
    t = duckdb_table()
    other = t.set_column(t.column_names.index("n"), "n", pa.array([2, 1, 5], pa.int64()))
    assert digest_table(SPEC, other) != digest_table(SPEC, t)


@pytest.mark.parametrize(
    ("value", "logical", "expected"),
    [
        (Decimal("3987.6"), "decimal", "3987.600000"),
        (Decimal("0.8333335"), "decimal", "0.833334"),
        (Decimal("-0"), "decimal", "0.000000"),
        (Decimal("5"), "int", "5"),
        (date(2025, 12, 31), "date", "2025-12-31"),
        (datetime(2026, 1, 1, 3, tzinfo=UTC), "timestamp", "2026-01-01T03:00:00.000000Z"),
        (datetime(2026, 1, 1, 3), "timestamp", "2026-01-01T03:00:00.000000Z"),
        (True, "bool", "true"),
        (None, "decimal", None),
    ],
)
def test_canonicalization_goldens(value, logical, expected):
    assert canon(value, logical) == expected


def test_floats_are_rejected():
    with pytest.raises(DigestError):
        canon(0.5, "decimal")


def test_ten_published_models_with_declared_keys():
    assert len(PUBLISHED_MODELS) == 10
    for spec in MODEL_SPECS.values():
        assert not any(c.startswith("_pl_") or c in ("received_at", "delivery_id") for c in spec.column_names)
        assert "NULLS LAST" in select_sql(spec, spec.schema)
