{#- Deliveries versus unique events per source and type: duplicates stay visible and countable (ADR 0001). -#}
with deliveries as (
    select source, event_type, count(*) as deliveries, count(distinct event_id) as unique_events
    from {{ source('peoplelake_raw', 'raw_event_deliveries') }}
    group by source, event_type
)

select
    source,
    event_type,
    cast(deliveries as {{ pl_int() }}) as deliveries,
    cast(unique_events as {{ pl_int() }}) as unique_events,
    cast(deliveries - unique_events as {{ pl_int() }}) as duplicate_deliveries
from deliveries
