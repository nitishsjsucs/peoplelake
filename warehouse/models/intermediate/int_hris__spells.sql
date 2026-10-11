{#- One row per employment spell [hire_date, termination_date], last day worked inclusive.
    A termination belongs to the latest hire before it; a rehire that arrives while the prior spell is
    still open closes that spell provisionally the day before (is_inferred_end, an anomaly). -#}
with effective as (
    select * from {{ ref('int_hris__effective_events') }}
),

hires as (
    select
        employee_id,
        spell_no,
        effective_date as hire_date,
        event_id as hire_event_id,
        event_type as hire_event_type,
        department_id,
        job_code,
        location_id,
        fte_bp,
        ats_candidate_id,
        hire_source
    from effective
    where event_type in ('worker.hired', 'worker.rehired')
),

ordered as (
    select
        h.*,
        lead(h.hire_date) over (
            partition by h.employee_id
            order by h.hire_date asc nulls last, h.spell_no asc nulls last, h.hire_event_id asc nulls last
        ) as next_hire_date
    from hires as h
),

terminations as (
    select employee_id, effective_date as termination_date, event_id, termination_type, reason_code
    from effective
    where event_type = 'worker.terminated'
),

matched as (
    select
        o.*,
        t.termination_date,
        t.event_id as termination_event_id,
        t.termination_type,
        t.reason_code,
        row_number() over (
            partition by o.employee_id, o.spell_no, o.hire_event_id
            order by t.termination_date asc nulls last, t.event_id asc nulls last
        ) as termination_rank
    from ordered as o
    left join terminations as t
        on t.employee_id = o.employee_id
        and t.termination_date > o.hire_date
        and (o.next_hire_date is null or t.termination_date < o.next_hire_date)
)

select
    employee_id,
    spell_no,
    hire_date,
    hire_event_id,
    hire_event_type,
    department_id as hire_department_id,
    job_code as hire_job_code,
    location_id,
    fte_bp as hire_fte_bp,
    ats_candidate_id,
    hire_source,
    termination_date,
    termination_event_id,
    termination_type,
    reason_code,
    case
        when termination_date is not null then termination_date
        when next_hire_date is not null then {{ pl_add_days('next_hire_date', -1) }}
    end as end_date,
    termination_date is null and next_hire_date is not null as is_inferred_end,
    {{ pl_employee_bucket('employee_id') }} as employee_bucket
from matched
where termination_rank = 1
