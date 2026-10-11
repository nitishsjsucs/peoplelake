{#- Attribute change points inside each spell, forward filled: one row per (employee, valid_from) with
    valid_to exclusive (the next change, the day after the spell ends, or 9999-12-31). -#}
with spells as (
    select * from {{ ref('int_hris__spells') }}
),

changes as (
    select
        e.employee_id,
        e.effective_date,
        e.event_id,
        e.event_type,
        case when e.event_type = 'worker.transferred' then e.to_department_id end as department_id,
        case when e.event_type = 'worker.job_changed' then e.to_job_code end as job_code,
        case when e.event_type = 'worker.fte_changed' then e.to_fte_bp end as fte_bp
    from {{ ref('int_hris__effective_events') }} as e
    where e.event_type in ('worker.transferred', 'worker.job_changed', 'worker.fte_changed')
),

points as (
    select
        s.employee_id,
        s.spell_no,
        s.hire_date as valid_from,
        s.hire_event_id as change_event_id,
        s.hire_event_type as change_event_type,
        0 as point_order,
        s.hire_department_id as department_id,
        s.hire_job_code as job_code,
        s.location_id,
        s.hire_fte_bp as fte_bp,
        s.end_date
    from spells as s

    union all

    select
        s.employee_id,
        s.spell_no,
        c.effective_date as valid_from,
        c.event_id as change_event_id,
        c.event_type as change_event_type,
        1 as point_order,
        c.department_id,
        c.job_code,
        cast(null as {{ pl_string() }}) as location_id,
        c.fte_bp,
        s.end_date
    from changes as c
    inner join spells as s
        on s.employee_id = c.employee_id
        and c.effective_date > s.hire_date
        and (s.end_date is null or c.effective_date <= s.end_date)
),

filled as (
    select
        employee_id,
        spell_no,
        valid_from,
        change_event_id,
        change_event_type,
        point_order,
        end_date,
        last_value(department_id ignore nulls) over w as department_id,
        last_value(job_code ignore nulls) over w as job_code,
        last_value(location_id ignore nulls) over w as location_id,
        last_value(fte_bp ignore nulls) over w as fte_bp
    from points
    window w as (
        partition by employee_id, spell_no
        order by valid_from asc nulls last, point_order asc nulls last, change_event_id asc nulls last
        rows between unbounded preceding and current row
    )
),

collapsed as (
    {#- Several changes on one day (only possible while data is in flight) keep the last state of the day. -#}
    select *
    from (
        select
            f.*,
            row_number() over (
                partition by f.employee_id, f.spell_no, f.valid_from
                order by f.point_order desc nulls last, f.change_event_id desc nulls last
            ) as day_rank
        from filled as f
    ) as ranked
    where day_rank = 1
)

select
    employee_id,
    spell_no,
    valid_from,
    coalesce(
        lead(valid_from) over (
            partition by employee_id, spell_no
            order by valid_from asc nulls last
        ),
        case when end_date is not null then {{ pl_add_days('end_date', 1) }} else {{ pl_open_end() }} end
    ) as valid_to,
    department_id,
    job_code,
    location_id,
    fte_bp,
    change_event_id,
    change_event_type,
    {{ pl_employee_bucket('employee_id') }} as employee_bucket
from collapsed
