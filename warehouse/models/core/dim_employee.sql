{#- Current state per employee as of the latest data: the latest spell and its last attribute row. -#}
with spells as (
    select
        s.*,
        row_number() over (
            partition by s.employee_id order by s.hire_date desc nulls last, s.spell_no desc nulls last
        ) as recency,
        count(*) over (partition by s.employee_id) as spell_count,
        min(s.hire_date) over (partition by s.employee_id) as first_hire_date
    from {{ ref('int_hris__spells') }} as s
),

latest as (
    select * from spells where recency = 1
),

last_rows as (
    select *
    from (
        select
            t.*,
            row_number() over (
                partition by t.employee_id, t.spell_no order by t.valid_from desc nulls last
            ) as row_recency
        from {{ ref('int_hris__attribute_timeline') }} as t
    ) as ranked
    where row_recency = 1
)

select
    l.employee_id,
    l.spell_no as current_spell_no,
    cast(l.spell_count as {{ pl_int() }}) as spell_count,
    l.first_hire_date,
    l.hire_date as latest_hire_date,
    l.termination_date,
    cast(case when l.end_date is null then 'active' else 'terminated' end as {{ pl_string() }}) as employment_status,
    r.department_id,
    r.job_code,
    r.location_id,
    {{ pl_bp_to_decimal('r.fte_bp') }} as fte,
    l.spell_count > 1 as is_rehire
from latest as l
left join last_rows as r
    on r.employee_id = l.employee_id
    and r.spell_no = l.spell_no
where {{ pl_fault_guard() }}
