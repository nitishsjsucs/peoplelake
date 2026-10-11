{{ config(severity='error') }}
{#- R4: every applied correction shows in the effective-dated history, computed by an independent path
    from the raw parsed events (not from int_hris__effective_events): the corrected value holds from the
    effective date, and the superseded value appears nowhere for that range. -#}
with hris as (
    select * from {{ ref('stg_hris__worker_events') }}
),

latest as (
    select
        corrects_event_id,
        {{ pl_last_non_null('corrected_effective_date', 'source_sequence') }} as corrected_effective_date,
        {{ pl_last_non_null('corrected_to_department_id', 'source_sequence') }} as corrected_to_department_id,
        {{ pl_last_non_null('corrected_to_fte_bp', 'source_sequence') }} as corrected_to_fte_bp
    from hris
    where event_type = 'worker.event_corrected'
    group by corrects_event_id
),

targets as (
    select t.event_id, t.employee_id, t.event_type, t.effective_date as recorded_date,
           t.to_department_id as recorded_department_id, t.to_fte_bp as recorded_fte_bp,
           c.corrected_effective_date, c.corrected_to_department_id, c.corrected_to_fte_bp
    from latest as c
    inner join hris as t on t.event_id = c.corrects_event_id
    where not exists (
        select 1 from hris as r where r.event_type = 'worker.event_rescinded' and r.rescinds_event_id = t.event_id
    )
),

history as (
    select * from {{ ref('dim_employee_history') }}
),

hire_violations as (
    select t.event_id, 'hire date not applied' as problem
    from targets as t
    inner join {{ ref('int_hris__spells') }} as s on s.hire_event_id = t.event_id
    where t.corrected_effective_date is not null
      and (
          s.hire_date <> t.corrected_effective_date
          or not exists (
              select 1 from history as h
              where h.employee_id = t.employee_id and h.spell_no = s.spell_no and h.valid_from = t.corrected_effective_date
          )
          or exists (
              select 1 from history as h
              where h.employee_id = t.employee_id and h.spell_no = s.spell_no
                and h.valid_from < t.corrected_effective_date
          )
      )
),

termination_violations as (
    select t.event_id, 'termination date not applied' as problem
    from targets as t
    inner join {{ ref('int_hris__spells') }} as s on s.termination_event_id = t.event_id
    where t.corrected_effective_date is not null
      and (
          s.termination_date <> t.corrected_effective_date
          or exists (
              select 1 from history as h
              where h.employee_id = t.employee_id and h.spell_no = s.spell_no
                and h.valid_to > {{ pl_add_days('t.corrected_effective_date', 1) }}
          )
      )
),

value_violations as (
    select t.event_id, 'corrected value not in history' as problem
    from targets as t
    inner join history as h
        on h.employee_id = t.employee_id
        and h.valid_from = coalesce(t.corrected_effective_date, t.recorded_date)
    where (t.corrected_to_department_id is not null
           and (h.department_id <> t.corrected_to_department_id or h.department_id = t.recorded_department_id))
       or (t.corrected_to_fte_bp is not null
           and (h.fte <> {{ pl_bp_to_decimal('t.corrected_to_fte_bp') }}
                or h.fte = {{ pl_bp_to_decimal('t.recorded_fte_bp') }}))
)

select * from hire_violations
union all select * from termination_violations
union all select * from value_violations
