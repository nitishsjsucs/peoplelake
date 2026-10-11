{{ config(severity='error') }}
{#- R5: no spell ends at a rescinded termination and departures never include one. -#}
with rescinded as (
    select rescinds_event_id as event_id
    from {{ ref('stg_hris__worker_events') }}
    where event_type = 'worker.event_rescinded'
)

select s.termination_event_id as event_id, 'spell ends at a rescinded termination' as problem
from {{ ref('int_hris__spells') }} as s
inner join rescinded as r on r.event_id = s.termination_event_id

union all

select e.event_id, 'departure counted for a rescinded termination' as problem
from {{ ref('fct_employment_events') }} as e
inner join rescinded as r on r.event_id = e.event_id
where e.event_kind = 'termination'
