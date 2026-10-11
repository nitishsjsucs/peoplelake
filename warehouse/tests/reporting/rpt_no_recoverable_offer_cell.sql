{{ config(severity='error') }}
{#- Small-cell suppression cannot be undone by subtraction: no month shows ALL while hiding exactly one
    department's offer cell (ALL minus the shown departments would be that cell). Returns violating months. -#}
select s.month, count(*) as hidden_department_cells
from {{ ref('rpt_metrics_monthly') }} as s
inner join {{ ref('rpt_metrics_monthly') }} as a on a.month = s.month and a.department_id = 'ALL'
where s.department_id <> 'ALL' and s.offers_suppressed and not a.offers_suppressed
group by s.month
having count(*) = 1
