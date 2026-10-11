{{ config(severity='error') }}
{#- R1: HC(m) = HC(m-1) + hires(m) - departures(m) - inferred exits(m) for the company, every month.
    Inferred exits (a rehire that arrived before the prior termination) are counted so the identity also
    holds while late data is in flight; R11 reports them. The month before the window is computed from
    the spells directly, an independent path from the snapshot. -#}
with spells as (
    select * from {{ ref('int_hris__spells') }}
),

base as (
    select count(*) as headcount
    from spells
    where hire_date <= cast('2022-12-31' as date)
      and (end_date is null or end_date > cast('2022-12-31' as date))
),

inferred as (
    select {{ pl_month_start('end_date') }} as month, count(*) as exits
    from spells
    where is_inferred_end
    group by {{ pl_month_start('end_date') }}
),

company as (
    select
        m.month,
        m.headcount,
        m.hires,
        m.departures,
        coalesce(i.exits, 0) as inferred_exits,
        lag(m.headcount) over (order by m.month asc nulls last) as previous_headcount
    from {{ ref('metrics_workforce_monthly') }} as m
    left join inferred as i on i.month = m.month
    where m.department_id = 'ALL'
)

select c.*
from company as c
cross join base as b
where c.headcount <> coalesce(c.previous_headcount, b.headcount) + c.hires - c.departures - c.inferred_exits
