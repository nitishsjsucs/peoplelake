{%- if target.type == 'bigquery' -%}
{#- Authorized view: analysts read peoplelake_reporting without access to peoplelake_core (SPEC 11.7). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_core') | trim}]) }}
{%- endif %}
{#- Reporting view over the metrics mart. Department cells with headcount below 5 are nulled. -#}
select
    m.month,
    m.department_id,
    case when m.department_id = 'ALL' or m.headcount >= 5 then m.headcount end as headcount,
    case when m.department_id = 'ALL' or m.headcount >= 5 then m.fte end as fte,
    case when m.department_id = 'ALL' or m.headcount >= 5 then m.hires end as hires,
    case when m.department_id = 'ALL' or m.headcount >= 5 then m.departures end as departures,
    m.department_id <> 'ALL' and m.headcount < 5 as is_suppressed
from {{ ref('metrics_workforce_monthly') }} as m
