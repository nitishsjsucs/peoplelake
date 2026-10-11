"""DuckDB: the local stand-in for BigQuery (ADR 0008: one process owns the file).

Every connection goes through `open_duckdb`, which uses the default configuration, read-write, and
sets the session time zone to UTC. Never `read_only=True` and never a `config=` dict: dbt-duckdb opens
the same file in the same process with `read_only=False, config={}`, and DuckDB refuses a second
in-process connection with a different configuration.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import duckdb
import pyarrow as pa

from ..lake.schema import RAW_COLUMNS
from .base import LoadStats
from .digest import MODEL_SPECS, digest_table, schema_for, select_sql

RAW_TABLE = "peoplelake_raw.raw_event_deliveries"
LOAD_LOG = "peoplelake_ops.load_log"

RAW_DDL = f"""
CREATE SCHEMA IF NOT EXISTS peoplelake_raw;
CREATE SCHEMA IF NOT EXISTS peoplelake_ops;
CREATE TABLE IF NOT EXISTS {RAW_TABLE} (
  event_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  event_type VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  source_sequence BIGINT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  effective_date VARCHAR NOT NULL,
  schema_version INTEGER NOT NULL,
  payload VARCHAR NOT NULL,
  payload_sha256 VARCHAR NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  delivery_id VARCHAR NOT NULL,
  ingest_request_id VARCHAR NOT NULL,
  producer VARCHAR NOT NULL,
  _pl_snapshot_id VARCHAR,
  _pl_load_run_id VARCHAR NOT NULL,
  _pl_load_job_id VARCHAR NOT NULL,
  _pl_loaded_at TIMESTAMPTZ NOT NULL,
  _pl_load_seq BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS {LOAD_LOG} (
  run_id VARCHAR NOT NULL,
  job_id VARCHAR NOT NULL,
  load_seq BIGINT NOT NULL,
  rows_read BIGINT NOT NULL,
  rows_inserted BIGINT NOT NULL,
  duplicate_deliveries_skipped BIGINT NOT NULL,
  unique_new_events BIGINT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL
);
"""


def open_duckdb(path: Path | str) -> duckdb.DuckDBPyConnection:
    """The only way this repo opens DuckDB: default config, read-write, session zone UTC."""
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(path))
    con.execute("SET TimeZone='UTC'")
    return con


@contextmanager
def connection(path: Path | str) -> Iterator[duckdb.DuckDBPyConnection]:
    con = open_duckdb(path)
    try:
        yield con
    finally:
        con.close()


# Events first loaded by this load_seq (any attempt of the run's load), at their first receipt.
LOAD_EVENTS_DUCKDB = f"""
CREATE OR REPLACE TEMP TABLE pl_new_events AS
SELECT r.event_id, min(r.received_at) AS first_received_at
FROM {RAW_TABLE} r
WHERE r.event_id IN (SELECT event_id FROM pl_batch)
GROUP BY r.event_id
HAVING min(r._pl_load_seq) = ?
"""


class DuckDBWarehouse:
    kind = "duckdb"

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def ensure_raw(self) -> None:
        with connection(self.path) as con:
            con.execute(RAW_DDL)

    def load_deliveries(
        self,
        batch: pa.Table,
        *,
        run_id: str,
        job_id: str,
        load_seq: int,
        snapshot_ids: list[str | None] | None = None,
    ) -> LoadStats:
        """Insert deliveries whose delivery_id is not present yet (idempotent; ADR 0001)."""
        ordinal = pa.array(range(batch.num_rows), type=pa.int64())
        snaps = pa.array(snapshot_ids if snapshot_ids is not None else [None] * batch.num_rows, type=pa.string())
        staged = batch.select(list(RAW_COLUMNS)).append_column("_pl_snapshot_id", snaps).append_column("_ord", ordinal)
        cols = ", ".join(RAW_COLUMNS)
        with connection(self.path) as con:
            con.execute(RAW_DDL)
            con.register("pl_batch", staged)
            con.execute("BEGIN TRANSACTION")
            try:
                con.execute(
                    f"""
                    CREATE OR REPLACE TEMP TABLE pl_new AS
                    SELECT * EXCLUDE (_ord) FROM (
                      SELECT * FROM pl_batch
                      QUALIFY row_number() OVER (PARTITION BY delivery_id ORDER BY _ord NULLS LAST) = 1
                    ) b
                    WHERE NOT EXISTS (SELECT 1 FROM {RAW_TABLE} r WHERE r.delivery_id = b.delivery_id)
                    """
                )
                inserted = con.execute("SELECT count(*) FROM pl_new").fetchone()[0]
                con.execute(
                    f"""
                    INSERT INTO {RAW_TABLE}
                    SELECT {cols}, _pl_snapshot_id, ?, ?, now(), ? FROM pl_new
                    """,
                    [run_id, job_id, load_seq],
                )
                # Stats of the run's load, not of this attempt: an event is new when its first row in raw
                # carries this load_seq, so a retried attempt (same load_seq) after one that merged and
                # never delivered its result reports the same events and histogram (SPEC 2.2, fault S4).
                con.execute(LOAD_EVENTS_DUCKDB, [load_seq])
                unique_new = con.execute("SELECT count(*) FROM pl_new_events").fetchone()[0]
                histogram = con.execute(
                    """
                    SELECT epoch_ms(first_received_at) // 10000 * 10 AS bucket, count(*)
                    FROM pl_new_events GROUP BY bucket ORDER BY bucket NULLS LAST
                    """
                ).fetchall()
                min_eff = con.execute(
                    f"SELECT min(effective_date) FROM {RAW_TABLE} WHERE _pl_load_seq = ?", [load_seq]
                ).fetchone()[0]
                con.execute(
                    f"INSERT INTO {LOAD_LOG} VALUES (?, ?, ?, ?, ?, ?, ?, now())",
                    [run_id, job_id, load_seq, batch.num_rows, inserted, batch.num_rows - inserted, unique_new],
                )
                con.execute("COMMIT")
            except Exception:
                con.execute("ROLLBACK")
                raise
            finally:
                con.unregister("pl_batch")
            raw_max = con.execute(f"SELECT max(_pl_load_seq) FROM {RAW_TABLE}").fetchone()[0]
        return LoadStats(
            rows_read=batch.num_rows,
            rows_inserted=int(inserted),
            duplicate_deliveries_skipped=batch.num_rows - int(inserted),
            unique_new_events=int(unique_new),
            raw_max_load_seq=None if raw_max is None else int(raw_max),
            min_effective_date_new=min_eff,
            received_histogram_10s=[(int(b), int(n)) for b, n in histogram],
        )

    def query_arrow(self, sql: str) -> pa.Table:
        with connection(self.path) as con:
            return con.execute(sql).to_arrow_table()

    def fetch_model(self, model: str, suffix: str | None = None) -> pa.Table:
        spec = MODEL_SPECS[model]
        return self.query_arrow(select_sql(spec, schema_for(spec, suffix)))

    def digests(self, suffix: str | None = None) -> dict[str, str]:
        out = {}
        with connection(self.path) as con:
            for name, spec in MODEL_SPECS.items():
                table = con.execute(select_sql(spec, schema_for(spec, suffix))).to_arrow_table()
                out[name] = digest_table(spec, table)
        return out

    def max_load_seq(self, base: str, table: str) -> int | None:
        try:
            with connection(self.path) as con:
                row = con.execute(f"SELECT max(_pl_load_seq) FROM {base}.{table}").fetchone()
        except duckdb.CatalogException:
            return None
        return None if row is None or row[0] is None else int(row[0])

    def freshness_histogram(self, after_seq: int) -> list[tuple[int, int]]:
        try:
            with connection(self.path) as con:
                rows = con.execute(
                    """
                    SELECT epoch_ms(first_received_at) // 10000 * 10 AS bucket, count(*)
                    FROM peoplelake_ops.ops_event_freshness WHERE _pl_load_seq > ?
                    GROUP BY bucket ORDER BY bucket NULLS LAST
                    """,
                    [after_seq],
                ).fetchall()
        except duckdb.CatalogException:
            return []
        return [(int(b), int(n)) for b, n in rows]

    def seed_checksum(self) -> str | None:
        return duckdb_seed_checksum(self)

    def set_seed_checksum(self, checksum: str) -> None:
        duckdb_set_seed_checksum(self, checksum)

    def reset(self) -> None:
        for suffix in ("", ".wal"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                p.unlink()


SEED_STATE_DDL = "CREATE TABLE IF NOT EXISTS peoplelake_ops.pl_seed_state (checksum VARCHAR NOT NULL, seeded_at TIMESTAMPTZ NOT NULL)"


def duckdb_seed_checksum(wh: DuckDBWarehouse) -> str | None:
    with connection(wh.path) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS peoplelake_ops")
        con.execute(SEED_STATE_DDL)
        row = con.execute(
            "SELECT checksum FROM peoplelake_ops.pl_seed_state ORDER BY seeded_at DESC NULLS LAST LIMIT 1"
        ).fetchone()
    return row[0] if row else None


def duckdb_set_seed_checksum(wh: DuckDBWarehouse, checksum: str) -> None:
    with connection(wh.path) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS peoplelake_ops")
        con.execute(SEED_STATE_DDL)
        con.execute("DELETE FROM peoplelake_ops.pl_seed_state")
        con.execute("INSERT INTO peoplelake_ops.pl_seed_state VALUES (?, now())", [checksum])
