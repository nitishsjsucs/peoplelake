"""BigQuery drills (SPEC 11.7, 20.5), run from a laptop with ADC impersonating peoplelake-runner, writing only to
`*_drill` datasets.

Restore drill: after dbt's CREATE OR REPLACE TABLE, `FOR SYSTEM_TIME AS OF` still reads the previous
version. A copy job would drop partitioning and policy tags, which the int64-range insert_overwrite and
column security need, so the restore is SQL into `_drill` with explicit partitioning and clustering; the
source schema's policy tags are copied onto the restored columns before anything reads them, and the drill
passes only when the restored digests equal the digests the ledger recorded for the run committed then.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..warehouse.digest import MODEL_SPECS

BUCKETED = {"dim_employee_history", "fct_workforce_monthly", "fct_compensation_history"}


@dataclass(frozen=True)
class RestoreStatement:
    model: str
    source: str
    target: str
    sql: str


def restore_sql(project: str, model: str, as_of_ms: int) -> RestoreStatement:
    spec = MODEL_SPECS[model]
    source = f"`{project}.{spec.schema}.{model}`"
    target = f"`{project}.{spec.schema}_drill.{model}`"
    partition = ""
    if model in BUCKETED:
        partition = "\nPARTITION BY RANGE_BUCKET(employee_bucket, GENERATE_ARRAY(0, 2048, 1))\nCLUSTER BY employee_id"
    sql = (
        f"CREATE OR REPLACE TABLE {target}{partition}\n"
        f"AS SELECT * FROM {source} FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS({int(as_of_ms)})"
    )
    return RestoreStatement(model, source.strip("`"), target.strip("`"), sql)


def copy_policy_tags(client, source_table: str, target_table: str) -> int:
    """Copy column policy tags from the source schema to the restored table; returns columns tagged."""
    from google.cloud import bigquery

    source = client.get_table(source_table)
    target = client.get_table(target_table)
    tags = {f.name: f.policy_tags for f in source.schema if f.policy_tags is not None and f.policy_tags.names}
    if not tags:
        return 0
    schema = []
    for f in target.schema:
        if f.name in tags:
            f = bigquery.SchemaField(
                f.name, f.field_type, mode=f.mode, description=f.description, policy_tags=tags[f.name]
            )
        schema.append(f)
    target.schema = schema
    client.update_table(target, ["schema"])
    return len(tags)


def drill_restore(client, project: str, as_of_ms: int, expected_digests: dict[str, str]) -> dict:
    """Restore every published model as of `as_of_ms` into `_drill` and compare digests with the ledger."""
    from ..warehouse.bigquery_wh import BigQueryWarehouse

    restored = {}
    for model in MODEL_SPECS:
        stmt = restore_sql(project, model, as_of_ms)
        client.query(stmt.sql).result()
        restored[model] = copy_policy_tags(client, stmt.source, stmt.target)
    digests = BigQueryWarehouse(client, project, suffix="drill").digests()
    mismatched = sorted(m for m in expected_digests if digests.get(m) != expected_digests[m])
    return {
        "as_of_ms": as_of_ms,
        "policy_tagged_columns": restored,
        "digests": digests,
        "mismatched": mismatched,
        "passed": not mismatched,
    }
