{#- Effective (corrected, not rescinded) employment events with the state after and before each one. -#}
with effective as (
    select * from {{ ref('int_hris__effective_events') }}
),

spells as (
    select * from {{ ref('int_hris__spells') }}
),

timeline as (
    select
        t.*,
        lag(t.department_id) over w as previous_department_id,
        lag(t.job_code) over w as previous_job_code,
        lag(t.fte_bp) over w as previous_fte_bp
    from {{ ref('int_hris__attribute_timeline') }} as t
    window w as (partition by t.employee_id, t.spell_no order by t.valid_from asc nulls last)
),

hires as (
    select
        s.hire_event_id as event_id,
        s.employee_id,
        s.spell_no,
        case when s.hire_event_type = 'worker.rehired' then 'rehire' else 'hire' end as event_kind,
        s.hire_date as effective_date,
        s.hire_department_id as department_id,
        cast(null as {{ pl_string() }}) as previous_department_id,
        s.hire_job_code as job_code,
        cast(null as {{ pl_string() }}) as previous_job_code,
        s.hire_fte_bp as fte_bp,
        cast(null as {{ pl_int() }}) as previous_fte_bp,
        cast(null as {{ pl_string() }}) as change_type,
        cast(null as {{ pl_string() }}) as termination_type
    from spells as s
),

changes as (
    select
        t.change_event_id as event_id,
        t.employee_id,
        t.spell_no,
        case t.change_event_type
            when 'worker.transferred' then 'transfer'
            when 'worker.job_changed' then 'job_change'
            else 'fte_change'
        end as event_kind,
        t.valid_from as effective_date,
        t.department_id,
        t.previous_department_id,
        t.job_code,
        t.previous_job_code,
        t.fte_bp,
        t.previous_fte_bp,
        e.change_type,
        cast(null as {{ pl_string() }}) as termination_type
    from timeline as t
    inner join effective as e on e.event_id = t.change_event_id
    where t.change_event_type in ('worker.transferred', 'worker.job_changed', 'worker.fte_changed')
),

terminations as (
    select
        s.termination_event_id as event_id,
        s.employee_id,
        s.spell_no,
        'termination' as event_kind,
        s.termination_date as effective_date,
        t.department_id,
        cast(null as {{ pl_string() }}) as previous_department_id,
        t.job_code,
        cast(null as {{ pl_string() }}) as previous_job_code,
        t.fte_bp,
        cast(null as {{ pl_int() }}) as previous_fte_bp,
        cast(null as {{ pl_string() }}) as change_type,
        s.termination_type
    from spells as s
    inner join timeline as t
        on t.employee_id = s.employee_id
        and t.spell_no = s.spell_no
        and t.valid_from <= s.termination_date
        and t.valid_to > s.termination_date
    where s.termination_event_id is not null
),

unioned as (
    select * from hires
    union all
    select * from changes
    union all
    select * from terminations
)

select
    u.event_id,
    u.employee_id,
    u.spell_no,
    cast(u.event_kind as {{ pl_string() }}) as event_kind,
    u.effective_date,
    u.department_id,
    u.previous_department_id,
    u.job_code,
    u.previous_job_code,
    {{ pl_bp_to_decimal('u.fte_bp') }} as fte,
    {{ pl_bp_to_decimal('u.previous_fte_bp') }} as previous_fte,
    u.change_type,
    u.termination_type,
    coalesce(e.is_corrected, false) as is_corrected
from unioned as u
left join effective as e on e.event_id = u.event_id
where {{ pl_fault_guard() }}
