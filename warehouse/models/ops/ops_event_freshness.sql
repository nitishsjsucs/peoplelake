{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='event_id',
    on_schema_change='fail'
) }}
{#- First receipt of every event and the load sequence that published it to the warehouse; the runner
    turns new rows into the 10 s freshness histogram it returns with each transform (ADR 0008). -#}
select
    e.event_id,
    e.source,
    e.received_at as first_received_at,
    e._pl_load_seq
from {{ ref('stg_events') }} as e
{% if pl_is_incremental() %}
where e._pl_load_seq > (select coalesce(max(t._pl_load_seq), -1) from {{ this }} as t)
{% endif %}
