{{ config(severity='warn') }}
{#- R7: unique events by source and type equal the manifest counts of var('pl_profile'). Error-level in
    `peoplelake prod verify` at quiescence, which also catches records accepted and then dropped. -#}
with actual as (
    select source, event_type, count(*) as actual_count
    from {{ ref('stg_events') }}
    group by source, event_type
),

expected as (
    select source, event_type, expected_count
    from {{ ref('expected_event_counts') }}
    where profile = '{{ var("pl_profile") }}'
)

select
    coalesce(a.source, e.source) as source,
    coalesce(a.event_type, e.event_type) as event_type,
    a.actual_count,
    e.expected_count
from actual as a
full outer join expected as e on e.source = a.source and e.event_type = a.event_type
where a.actual_count is null or e.expected_count is null or a.actual_count <> e.expected_count
