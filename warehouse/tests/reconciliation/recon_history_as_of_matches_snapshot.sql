{{ config(severity='error') }}
{#- pl_employee_as_of(d) over the SCD2 history agrees with the monthly snapshot at every month end
    (the snapshot excludes employees whose last day worked is the month end itself). -#}
{% set month_ends = ['2023-01-31', '2023-06-30', '2023-12-31', '2024-02-29', '2024-09-30', '2025-03-31', '2025-12-31'] %}
{% for d in month_ends %}
select cast('{{ d }}' as date) as month_end, count(*) as as_of_rows, max(snapshot_rows) as snapshot_rows
from ({{ pl_employee_as_of("'" ~ d ~ "'") }}) as a
inner join {{ ref('int_hris__spells') }} as s on s.employee_id = a.employee_id and s.spell_no = a.spell_no
cross join (
    select count(*) as snapshot_rows from {{ ref('fct_workforce_monthly') }} where month_end = cast('{{ d }}' as date)
) as snap
where s.end_date is null or s.end_date > cast('{{ d }}' as date)
having count(*) <> max(snapshot_rows)
{% if not loop.last %}union all{% endif %}
{% endfor %}
