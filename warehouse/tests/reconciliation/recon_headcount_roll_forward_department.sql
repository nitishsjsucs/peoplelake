{{ config(severity='error') }}
{#- R2: per department, HC(m) = HC(m-1) + hires - departures - inferred exits + transfers in - transfers out. -#}
with spells as (
    select * from {{ ref('int_hris__spells') }}
),

timeline as (
    select * from {{ ref('int_hris__attribute_timeline') }}
),

base as (
    select t.department_id, count(*) as headcount
    from spells as s
    inner join timeline as t
        on t.employee_id = s.employee_id
        and t.spell_no = s.spell_no
        and t.valid_from <= cast('2022-12-31' as date)
        and t.valid_to > cast('2022-12-31' as date)
    where s.end_date is null or s.end_date > cast('2022-12-31' as date)
    group by t.department_id
),

inferred as (
    select {{ pl_month_start('s.end_date') }} as month, t.department_id, count(*) as exits
    from spells as s
    inner join timeline as t
        on t.employee_id = s.employee_id
        and t.spell_no = s.spell_no
        and t.valid_from <= s.end_date
        and t.valid_to > s.end_date
    where s.is_inferred_end
    group by {{ pl_month_start('s.end_date') }}, t.department_id
),

departments as (
    select
        m.month,
        m.department_id,
        m.headcount,
        m.hires,
        m.departures,
        m.transfers_in,
        m.transfers_out,
        coalesce(i.exits, 0) as inferred_exits,
        lag(m.headcount) over (partition by m.department_id order by m.month asc nulls last) as previous_headcount
    from {{ ref('metrics_workforce_monthly') }} as m
    left join inferred as i on i.month = m.month and i.department_id = m.department_id
    where m.department_id <> 'ALL'
)

select d.*
from departments as d
left join base as b on b.department_id = d.department_id
where d.headcount <> coalesce(d.previous_headcount, b.headcount, 0)
    + d.hires - d.departures - d.inferred_exits + d.transfers_in - d.transfers_out
