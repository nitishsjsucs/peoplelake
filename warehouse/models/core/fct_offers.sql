{#- Accumulating snapshot: one row per extended offer with its decision and the hire it led to. -#}
with offer_events as (
    select * from {{ ref('stg_ats__offers') }}
),

extended as (
    select *
    from (
        select
            o.*,
            row_number() over (partition by o.offer_id order by o.source_sequence desc nulls last) as recency
        from offer_events as o
        where o.event_type = 'offer.extended'
    ) as ranked
    where recency = 1
),

decisions as (
    select *
    from (
        select
            o.*,
            row_number() over (partition by o.offer_id order by o.source_sequence desc nulls last) as recency
        from offer_events as o
        where o.event_type in ('offer.accepted', 'offer.declined', 'offer.rescinded')
    ) as ranked
    where recency = 1
),

requisitions as (
    select *
    from (
        select
            r.*,
            row_number() over (partition by r.requisition_id order by r.source_sequence desc nulls last) as recency
        from {{ ref('stg_ats__requisitions') }} as r
        where r.event_type = 'requisition.opened'
    ) as ranked
    where recency = 1
),

hires as (
    select ats_candidate_id, min(employee_id) as employee_id
    from {{ ref('int_hris__spells') }}
    where ats_candidate_id is not null
    group by ats_candidate_id
)

select
    e.offer_id,
    e.requisition_id,
    e.application_id,
    e.candidate_id,
    r.department_id,
    r.job_code,
    e.effective_date as extended_date,
    d.effective_date as decision_date,
    cast(case d.event_type
        when 'offer.accepted' then 'accepted'
        when 'offer.declined' then 'declined'
        when 'offer.rescinded' then 'rescinded'
        else 'pending'
    end as {{ pl_string() }}) as final_status,
    coalesce(d.start_date, e.proposed_start_date) as start_date,
    case when d.event_type = 'offer.accepted' then h.employee_id end as hired_employee_id
from extended as e
left join decisions as d on d.offer_id = e.offer_id
left join requisitions as r on r.requisition_id = e.requisition_id
left join hires as h on h.ats_candidate_id = e.candidate_id
where {{ pl_fault_guard() }}
