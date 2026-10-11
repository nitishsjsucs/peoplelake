{#- The five workforce metrics plus their components, one definition used everywhere (SPEC 11.4).
    One row per month of the window and department, plus department_id = 'ALL' for the company. -#}
with months as (
    select distinct month_start as month, month_end
    from {{ ref('dim_date') }}
    where date_day between cast('{{ var("pl_window_start") }}' as date) and cast('{{ var("pl_window_end") }}' as date)
),

grid as (
    select m.month, m.month_end, d.department_id
    from months as m
    cross join {{ ref('dim_department') }} as d
),

headcount as (
    select
        month_end,
        department_id,
        count(*) as headcount,
        sum(fte) as fte
    from {{ ref('fct_workforce_monthly') }}
    group by month_end, department_id
),

events as (
    select
        {{ pl_month_start('effective_date') }} as month,
        event_kind,
        department_id,
        previous_department_id
    from {{ ref('fct_employment_events') }}
),

hires as (
    select
        month,
        department_id,
        count(*) as hires,
        sum(case when event_kind = 'rehire' then 1 else 0 end) as rehires
    from events
    where event_kind in ('hire', 'rehire')
    group by month, department_id
),

departures as (
    select month, department_id, count(*) as departures
    from events
    where event_kind = 'termination'
    group by month, department_id
),

transfers_in as (
    select month, department_id, count(*) as transfers_in
    from events
    where event_kind = 'transfer'
    group by month, department_id
),

transfers_out as (
    select month, previous_department_id as department_id, count(*) as transfers_out
    from events
    where event_kind = 'transfer'
    group by month, previous_department_id
),

offers_extended as (
    select {{ pl_month_start('extended_date') }} as month, department_id, count(*) as offers_extended
    from {{ ref('fct_offers') }}
    group by {{ pl_month_start('extended_date') }}, department_id
),

offers_decided as (
    select
        {{ pl_month_start('decision_date') }} as month,
        department_id,
        sum(case when final_status = 'accepted' then 1 else 0 end) as offers_accepted,
        sum(case when final_status = 'declined' then 1 else 0 end) as offers_declined
    from {{ ref('fct_offers') }}
    where final_status in ('accepted', 'declined')
    group by {{ pl_month_start('decision_date') }}, department_id
),

by_department as (
    select
        g.month,
        g.department_id,
        cast(coalesce(hc.headcount, 0) as {{ pl_int() }}) as headcount,
        cast(coalesce(hc.fte, 0) as {{ pl_decimal_type() }}) as fte,
        cast(coalesce(h.hires, 0) as {{ pl_int() }}) as hires,
        cast(coalesce(h.rehires, 0) as {{ pl_int() }}) as rehires,
        cast(coalesce(dp.departures, 0) as {{ pl_int() }}) as departures,
        cast(coalesce(ti.transfers_in, 0) as {{ pl_int() }}) as transfers_in,
        cast(coalesce(tou.transfers_out, 0) as {{ pl_int() }}) as transfers_out,
        cast(coalesce(oe.offers_extended, 0) as {{ pl_int() }}) as offers_extended,
        cast(coalesce(od.offers_accepted, 0) as {{ pl_int() }}) as offers_accepted,
        cast(coalesce(od.offers_declined, 0) as {{ pl_int() }}) as offers_declined
    from grid as g
    left join headcount as hc on hc.month_end = g.month_end and hc.department_id = g.department_id
    left join hires as h on h.month = g.month and h.department_id = g.department_id
    left join departures as dp on dp.month = g.month and dp.department_id = g.department_id
    left join transfers_in as ti on ti.month = g.month and ti.department_id = g.department_id
    left join transfers_out as tou on tou.month = g.month and tou.department_id = g.department_id
    left join offers_extended as oe on oe.month = g.month and oe.department_id = g.department_id
    left join offers_decided as od on od.month = g.month and od.department_id = g.department_id
),

company as (
    select
        month,
        cast('ALL' as {{ pl_string() }}) as department_id,
        cast(sum(headcount) as {{ pl_int() }}) as headcount,
        cast(sum(fte) as {{ pl_decimal_type() }}) as fte,
        cast(sum(hires) as {{ pl_int() }}) as hires,
        cast(sum(rehires) as {{ pl_int() }}) as rehires,
        cast(sum(departures) as {{ pl_int() }}) as departures,
        cast(sum(transfers_in) as {{ pl_int() }}) as transfers_in,
        cast(sum(transfers_in) as {{ pl_int() }}) as transfers_out,
        cast(sum(offers_extended) as {{ pl_int() }}) as offers_extended,
        cast(sum(offers_accepted) as {{ pl_int() }}) as offers_accepted,
        cast(sum(offers_declined) as {{ pl_int() }}) as offers_declined
    from by_department
    group by month
),

unioned as (
    select * from by_department
    union all
    select * from company
)

select
    month,
    department_id,
    headcount,
    fte,
    hires,
    rehires,
    departures,
    transfers_in,
    transfers_out,
    offers_extended,
    offers_accepted,
    offers_declined,
    {{ pl_ppm_rate('offers_accepted', 'offers_accepted + offers_declined') }} as offer_acceptance_rate
from unioned
where {{ pl_fault_guard() }}
