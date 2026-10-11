{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='event_id',
    cluster_by=['source', 'event_type'] if target.type == 'bigquery' else none,
    on_schema_change='fail'
) }}
{#- One row per event: insert-only in effect. New raw rows are those with a load sequence above this
    model's cursor; events already present are anti-joined away, and within a batch the earliest
    delivery wins (ties by delivery_id), so a later duplicate never overwrites the first delivery
    and never marks an employee bucket dirty. -#}
with new_rows as (
    select
        r.event_id,
        r.source,
        r.event_type,
        r.entity_id,
        r.source_sequence,
        r.source_updated_at,
        cast(r.effective_date as date) as effective_date,
        r.schema_version,
        r.payload,
        r.payload_sha256,
        r.received_at,
        r.delivery_id,
        r._pl_load_seq,
        row_number() over (
            partition by r.event_id
            order by r.received_at asc nulls last, r.delivery_id asc nulls last
        ) as delivery_rank
    from {{ source('peoplelake_raw', 'raw_event_deliveries') }} as r
    {% if pl_is_incremental() %}
    where r._pl_load_seq > (select coalesce(max(t._pl_load_seq), -1) from {{ this }} as t)
      and not exists (select 1 from {{ this }} as t2 where t2.event_id = r.event_id)
    {% endif %}
)

select
    event_id,
    source,
    event_type,
    entity_id,
    source_sequence,
    source_updated_at,
    effective_date,
    schema_version,
    payload,
    payload_sha256,
    received_at,
    delivery_id,
    _pl_load_seq
from new_rows
where delivery_rank = 1
