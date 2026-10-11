{{ config(severity='error') }}
{#- R3: spells of an employee never overlap, spell numbers increase with hire dates, a rehire has
    spell_no > 1 and a hire spell_no = 1 (same employee_id across spells by construction). A missing
    prior spell is a completeness problem reported by R11 (rehire_without_prior_spell). -#}
with spells as (
    select
        s.*,
        lag(s.spell_no) over (partition by s.employee_id order by s.hire_date asc nulls last, s.spell_no asc nulls last) as previous_spell_no,
        lag(s.end_date) over (partition by s.employee_id order by s.hire_date asc nulls last, s.spell_no asc nulls last) as previous_end_date,
        lag(s.hire_date) over (partition by s.employee_id order by s.hire_date asc nulls last, s.spell_no asc nulls last) as previous_hire_date
    from {{ ref('int_hris__spells') }} as s
)

select employee_id, spell_no, hire_date, previous_spell_no, previous_end_date
from spells
where (hire_event_type = 'worker.rehired' and spell_no <= 1)
   or (hire_event_type = 'worker.hired' and spell_no <> 1)
   or (previous_spell_no is not null and spell_no <= previous_spell_no)
   or (previous_hire_date is not null and (previous_end_date is null or hire_date <= previous_end_date))
