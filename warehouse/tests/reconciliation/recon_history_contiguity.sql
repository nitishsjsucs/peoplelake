{{ config(severity='error') }}
{#- R9: SCD2 rows of a spell are non-empty, non-overlapping and contiguous, start at the hire date and end
    the day after the spell ends (or stay open). -#}
with history as (
    select
        h.*,
        lead(h.valid_from) over (partition by h.employee_id, h.spell_no order by h.valid_from asc nulls last) as next_valid_from,
        row_number() over (partition by h.employee_id, h.spell_no order by h.valid_from asc nulls last) as row_first,
        row_number() over (partition by h.employee_id, h.spell_no order by h.valid_from desc nulls last) as row_last
    from {{ ref('dim_employee_history') }} as h
),

spells as (
    select * from {{ ref('int_hris__spells') }}
)

select h.employee_id, h.spell_no, h.valid_from, h.valid_to, 'interval' as problem
from history as h
where h.valid_to <= h.valid_from
   or (h.next_valid_from is not null and h.next_valid_from <> h.valid_to)

union all

select h.employee_id, h.spell_no, h.valid_from, h.valid_to, 'spell bounds' as problem
from history as h
inner join spells as s on s.employee_id = h.employee_id and s.spell_no = h.spell_no
where (h.row_first = 1 and h.valid_from <> s.hire_date)
   or (h.row_last = 1 and s.end_date is null and h.valid_to <> {{ pl_open_end() }})
   or (h.row_last = 1 and s.end_date is not null and h.valid_to <> {{ pl_add_days('s.end_date', 1) }})

union all

select s.employee_id, s.spell_no, s.hire_date, s.end_date, 'spell without history' as problem
from spells as s
where not exists (select 1 from history as h where h.employee_id = s.employee_id and h.spell_no = s.spell_no)
