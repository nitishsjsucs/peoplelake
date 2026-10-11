"""BigQuery warehouse (production). Batch load jobs are free; deduplication is a MERGE on delivery_id.
Every query is capped at 1 GB billed and every job is labeled `app=peoplelake` (SPEC 29.4.6): the project is
shared by four repos and its free tiers with them.

Load: Arrow -> Parquet in memory -> load job into `peoplelake_raw._stage_<job>` (WRITE_TRUNCATE, expires in a
day) -> stats query -> `MERGE peoplelake_raw.raw_event_deliveries T USING (deduplicated stage) S ON
T.delivery_id = S.delivery_id WHEN NOT MATCHED THEN INSERT` -> `peoplelake_ops.load_log` -> drop the stage.
Re-running a load inserts nothing (ADR 0001). The raw table is partitioned by DATE(_pl_loaded_at) and
clustered by source, event_type, event_id.
"""

from __future__ import annotations

import io
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ..budget import BQ_LABELS, BQ_MAX_BYTES_BILLED
from ..lake.schema import RAW_COLUMNS
from .base import LoadStats
from .digest import MODEL_SPECS, ModelSpec, digest_table, schema_for, select_sql

RAW_DDL = """
CREATE TABLE IF NOT EXISTS `{raw}` (
  event_id STRING NOT NULL,
  source STRING NOT NULL,
  event_type STRING NOT NULL,
  entity_id STRING NOT NULL,
  source_sequence INT64 NOT NULL,
  source_updated_at TIMESTAMP NOT NULL,
  effective_date STRING NOT NULL,
  schema_version INT64 NOT NULL,
  payload STRING NOT NULL,
  payload_sha256 STRING NOT NULL,
  received_at TIMESTAMP NOT NULL,
  delivery_id STRING NOT NULL,
  ingest_request_id STRING NOT NULL,
  producer STRING NOT NULL,
  _pl_snapshot_id STRING,
  _pl_load_run_id STRING NOT NULL,
  _pl_load_job_id STRING NOT NULL,
  _pl_loaded_at TIMESTAMP NOT NULL,
  _pl_load_seq INT64 NOT NULL
)
PARTITION BY DATE(_pl_loaded_at)
CLUSTER BY source, event_type, event_id
OPTIONS (description = 'PeopleLake raw deliveries: one row per accepted delivery, deduplicated on delivery_id')
"""

LOAD_LOG_DDL = """
CREATE TABLE IF NOT EXISTS `{log}` (
  run_id STRING NOT NULL,
  job_id STRING NOT NULL,
  load_seq INT64 NOT NULL,
  rows_read INT64 NOT NULL,
  rows_inserted INT64 NOT NULL,
  duplicate_deliveries_skipped INT64 NOT NULL,
  unique_new_events INT64 NOT NULL,
  loaded_at TIMESTAMP NOT NULL
)
"""

DEDUPED_STAGE = """
SELECT * EXCEPT (_ord) FROM `{stage}` WHERE TRUE
QUALIFY ROW_NUMBER() OVER (PARTITION BY delivery_id ORDER BY _ord ASC NULLS LAST) = 1
"""

# Stats of the run's load, read after the MERGE: an event is new when its first row in raw carries this
# load_seq, so a retried attempt (same load_seq) after one that merged and never delivered its result
# reports the same events and histogram (SPEC 2.2, fault S4).
STATS_SQL = """
WITH batch_events AS (SELECT DISTINCT event_id FROM `{stage}`),
new_events AS (
  SELECT r.event_id, MIN(r.received_at) AS first_received_at
  FROM `{raw}` AS r JOIN batch_events AS b ON r.event_id = b.event_id
  GROUP BY r.event_id
  HAVING MIN(r._pl_load_seq) = @load_seq
)
SELECT
  (SELECT COUNT(*) FROM new_events) AS unique_new_events,
  (SELECT MIN(effective_date) FROM `{raw}` WHERE _pl_load_seq = @load_seq) AS min_effective_date_new,
  ARRAY(
    SELECT AS STRUCT DIV(UNIX_SECONDS(first_received_at), 10) * 10 AS bucket, COUNT(*) AS n
    FROM new_events GROUP BY bucket ORDER BY bucket ASC NULLS LAST
  ) AS histogram
"""

MERGE_SQL = """
MERGE `{raw}` AS T
USING ({deduped}) AS S
ON T.delivery_id = S.delivery_id
WHEN NOT MATCHED THEN
  INSERT ({columns}, _pl_snapshot_id, _pl_load_run_id, _pl_load_job_id, _pl_loaded_at, _pl_load_seq)
  VALUES ({source_columns}, S._pl_snapshot_id, @run_id, @job_id, CURRENT_TIMESTAMP(), @load_seq)
"""

LOG_SQL = """
INSERT INTO `{log}` (run_id, job_id, load_seq, rows_read, rows_inserted, duplicate_deliveries_skipped,
                     unique_new_events, loaded_at)
VALUES (@run_id, @job_id, @load_seq, @rows_read, @rows_inserted, @duplicates, @unique_new_events, CURRENT_TIMESTAMP())
"""

MAX_SEQ_SQL = "SELECT MAX(_pl_load_seq) AS m FROM `{raw}`"


def stage_name(job_id: str) -> str:
    return "_stage_" + re.sub(r"[^A-Za-z0-9_]", "_", job_id)


class BigQueryWarehouse:
    kind = "bigquery"

    def __init__(self, client: Any, project: str, *, location: str = "US", suffix: str | None = None) -> None:
        self.client = client
        self.project = project
        self.location = location
        self.suffix = suffix
        self.bytes_billed = 0  # every query this object ran (the monthly guard sums the loads' share)

    def dataset(self, base: str) -> str:
        return f"{self.project}.{base}_{self.suffix}" if self.suffix else f"{self.project}.{base}"

    @property
    def raw(self) -> str:
        return f"{self.dataset('peoplelake_raw')}.raw_event_deliveries"

    @property
    def load_log(self) -> str:
        return f"{self.dataset('peoplelake_ops')}.load_log"

    def _query(self, sql: str, params: list[Any] | None = None) -> Any:
        from google.cloud import bigquery

        config = bigquery.QueryJobConfig(
            query_parameters=params or [], maximum_bytes_billed=BQ_MAX_BYTES_BILLED, labels=dict(BQ_LABELS)
        )
        job = self.client.query(sql, job_config=config, location=self.location)
        job.result()
        self.bytes_billed += int(getattr(job, "total_bytes_billed", None) or 0)
        return job

    def ensure_raw(self) -> None:
        self._query(RAW_DDL.format(raw=self.raw))
        self._query(LOAD_LOG_DDL.format(log=self.load_log))

    def load_deliveries(
        self,
        batch: pa.Table,
        *,
        run_id: str,
        job_id: str,
        load_seq: int,
        snapshot_ids: list[str | None] | None = None,
    ) -> LoadStats:
        from google.cloud import bigquery

        billed_before = self.bytes_billed
        stage = f"{self.dataset('peoplelake_raw')}.{stage_name(job_id)}"
        snaps = pa.array(snapshot_ids if snapshot_ids is not None else [None] * batch.num_rows, type=pa.string())
        staged = (
            batch.select(list(RAW_COLUMNS))
            .append_column("_pl_snapshot_id", snaps)
            .append_column("_ord", pa.array(range(batch.num_rows), type=pa.int64()))
        )
        buf = io.BytesIO()
        pq.write_table(staged, buf)
        buf.seek(0)
        load_config = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            labels=dict(BQ_LABELS),
        )
        self.client.load_table_from_file(buf, stage, job_config=load_config, location=self.location).result()
        table = self.client.get_table(stage)
        table.expires = datetime.now(UTC) + timedelta(days=1)
        self.client.update_table(table, ["expires"])
        try:
            deduped = DEDUPED_STAGE.format(stage=stage)
            params = [
                bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
                bigquery.ScalarQueryParameter("job_id", "STRING", job_id),
                bigquery.ScalarQueryParameter("load_seq", "INT64", load_seq),
            ]
            merge = self._query(
                MERGE_SQL.format(
                    raw=self.raw,
                    deduped=deduped,
                    columns=", ".join(RAW_COLUMNS),
                    source_columns=", ".join(f"S.{c}" for c in RAW_COLUMNS),
                ),
                params,
            )
            inserted = int(merge.num_dml_affected_rows or 0)
            stats = list(self._query(STATS_SQL.format(stage=stage, raw=self.raw), params).result())[0]
            self._query(
                LOG_SQL.format(log=self.load_log),
                [
                    *params,
                    bigquery.ScalarQueryParameter("rows_read", "INT64", batch.num_rows),
                    bigquery.ScalarQueryParameter("rows_inserted", "INT64", inserted),
                    bigquery.ScalarQueryParameter("duplicates", "INT64", batch.num_rows - inserted),
                    bigquery.ScalarQueryParameter("unique_new_events", "INT64", int(stats["unique_new_events"])),
                ],
            )
            raw_max = list(self._query(MAX_SEQ_SQL.format(raw=self.raw)).result())[0]["m"]
        finally:
            self.client.delete_table(stage, not_found_ok=True)
        return LoadStats(
            rows_read=batch.num_rows,
            rows_inserted=inserted,
            duplicate_deliveries_skipped=batch.num_rows - inserted,
            unique_new_events=int(stats["unique_new_events"]),
            raw_max_load_seq=None if raw_max is None else int(raw_max),
            min_effective_date_new=stats["min_effective_date_new"],
            received_histogram_10s=[(int(h["bucket"]), int(h["n"])) for h in stats["histogram"]],
            bytes_billed=self.bytes_billed - billed_before,
        )

    def fetch_model(self, model: str | ModelSpec, suffix: str | None = None) -> pa.Table:
        spec = model if isinstance(model, ModelSpec) else MODEL_SPECS[model]
        schema = f"`{self.project}`.{schema_for(spec, suffix if suffix is not None else self.suffix)}"
        return self._query(select_sql(spec, schema)).to_arrow()

    def digests(self, suffix: str | None = None) -> dict[str, str]:
        return {name: digest_table(spec, self.fetch_model(name, suffix)) for name, spec in MODEL_SPECS.items()}

    def max_load_seq(self, base: str, table: str) -> int | None:
        from google.api_core.exceptions import NotFound

        try:
            rows = list(self._query(f"SELECT MAX(_pl_load_seq) AS m FROM `{self.dataset(base)}.{table}`").result())
        except NotFound:
            return None
        value = rows[0]["m"] if rows else None
        return None if value is None else int(value)

    def freshness_histogram(self, after_seq: int) -> list[tuple[int, int]]:
        from google.api_core.exceptions import NotFound
        from google.cloud import bigquery

        sql = f"""
            SELECT DIV(UNIX_SECONDS(first_received_at), 10) * 10 AS bucket, COUNT(*) AS n
            FROM `{self.dataset("peoplelake_ops")}.ops_event_freshness` WHERE _pl_load_seq > @after
            GROUP BY bucket ORDER BY bucket ASC NULLS LAST
        """
        try:
            rows = self._query(sql, [bigquery.ScalarQueryParameter("after", "INT64", after_seq)]).result()
        except NotFound:
            return []
        return [(int(r["bucket"]), int(r["n"])) for r in rows]

    def seed_checksum(self) -> str | None:
        from google.api_core.exceptions import NotFound

        self._query(
            f"CREATE TABLE IF NOT EXISTS `{self.dataset('peoplelake_ops')}.pl_seed_state` (checksum STRING NOT NULL, seeded_at TIMESTAMP NOT NULL)"
        )
        try:
            rows = list(
                self._query(
                    f"SELECT checksum FROM `{self.dataset('peoplelake_ops')}.pl_seed_state` ORDER BY seeded_at DESC NULLS LAST LIMIT 1"
                ).result()
            )
        except NotFound:
            return None
        return rows[0]["checksum"] if rows else None

    def set_seed_checksum(self, checksum: str) -> None:
        from google.cloud import bigquery

        table = f"`{self.dataset('peoplelake_ops')}.pl_seed_state`"
        self._query(f"DELETE FROM {table} WHERE TRUE")
        self._query(
            f"INSERT INTO {table} VALUES (@c, CURRENT_TIMESTAMP())",
            [bigquery.ScalarQueryParameter("c", "STRING", checksum)],
        )

    def reset(self) -> None:
        """Empty the drill datasets (scenario drills start from empty state). Never touches production."""
        if self.suffix != "drill":
            raise RuntimeError("BigQuery datasets are reset only by `peoplelake prod reset` (guarded) or drills")
        for base in (
            "peoplelake_raw",
            "peoplelake_staging",
            "peoplelake_core",
            "peoplelake_restricted",
            "peoplelake_reporting",
            "peoplelake_ops",
        ):
            for table in self.client.list_tables(self.dataset(base)):
                self.client.delete_table(table.reference, not_found_ok=True)

    def oracle_mismatches(self, profile: str) -> int:
        from google.cloud import bigquery

        sql = f"""
            SELECT COUNT(*) AS n FROM `{self.dataset("peoplelake_core")}.metrics_workforce_monthly` m
            FULL OUTER JOIN (SELECT * FROM `{self.dataset("peoplelake_ops")}.oracle_workforce_monthly` WHERE profile = @p) o
              ON o.month = m.month AND o.department_id = m.department_id
            WHERE m.month IS NULL OR o.month IS NULL
               OR TO_JSON_STRING(STRUCT(m.headcount, m.fte, m.hires, m.rehires, m.departures, m.transfers_in, m.transfers_out,
                    m.offers_extended, m.offers_accepted, m.offers_declined, m.offer_acceptance_rate))
               != TO_JSON_STRING(STRUCT(o.headcount, o.fte, o.hires, o.rehires, o.departures, o.transfers_in, o.transfers_out,
                    o.offers_extended, o.offers_accepted, o.offers_declined, o.offer_acceptance_rate))
        """
        rows = list(self._query(sql, [bigquery.ScalarQueryParameter("p", "STRING", profile)]).result())
        return int(rows[0]["n"])

    def raw_counts(self) -> dict:
        rows = list(self._query(f"SELECT COUNT(*) AS d, COUNT(DISTINCT event_id) AS u FROM `{self.raw}`").result())
        d, u = int(rows[0]["d"]), int(rows[0]["u"])
        return {"raw_deliveries": d, "unique_events": u, "duplicate_deliveries_in_raw": d - u}


def default_query_job_config():
    """Every query: at most 1 GB billed, labeled app=peoplelake."""
    from google.cloud import bigquery

    return bigquery.QueryJobConfig(maximum_bytes_billed=BQ_MAX_BYTES_BILLED, labels=dict(BQ_LABELS))


def bigquery_client(project: str, location: str, impersonate: str | None = None, *, credentials: Any = None):
    """The only way this repo creates a BigQuery client: ADC (or `credentials`), impersonating a service
    account when given (drills, masking demo), with the 1 GB cap and the label as the default job config."""
    from google.cloud import bigquery

    creds = credentials
    if creds is None and impersonate:
        import google.auth
        from google.auth import impersonated_credentials

        source, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds = impersonated_credentials.Credentials(
            source_credentials=source,
            target_principal=impersonate,
            target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
    return bigquery.Client(
        project=project,
        location=location,
        default_query_job_config=default_query_job_config(),
        **({"credentials": creds} if creds is not None else {}),
    )
