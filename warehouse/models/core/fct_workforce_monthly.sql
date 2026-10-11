{{ config(**pl_bucketed_config(['employee_id'], ['hris'])) }}
{#- Periodic snapshot: one row per employee counted in headcount at each month end of the window.
    Counted means hired on or before the month end and not ended on or before it (last day worked is
    inclusive, so a termination dated on the month end is a departure, not headcount). -#}
with months as (
    select distinct month_end
    from {{ ref('dim_date') }}
    where date_day between cast('{{ var("pl_window_start") }}' as date) and cast('{{ var("pl_window_end") }}' as date)
),

timeline as (
    select t.*
    from {{ ref('int_hris__attribute_timeline') }} as t
    {% if pl_is_incremental() %}
    where t.employee_bucket in ({{ pl_affected_buckets(this, ['hris']) }})
    {% endif %}
)

select
    t.employee_id,
    m.month_end,
    t.spell_no,
    t.department_id,
    t.job_code,
    t.location_id,
    {{ pl_bp_to_decimal('t.fte_bp') }} as fte,
    t.employee_bucket,
    {{ pl_consumed_load_seq(['hris']) }} as _pl_load_seq
from timeline as t
inner join {{ ref('int_hris__spells') }} as s
    on s.employee_id = t.employee_id
    and s.spell_no = t.spell_no
inner join months as m
    on t.valid_from <= m.month_end
    and t.valid_to > m.month_end
where (s.end_date is null or s.end_date > m.month_end)
  and {{ pl_fault_guard() }}
