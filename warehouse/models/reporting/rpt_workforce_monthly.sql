{%- if target.type == 'bigquery' -%}
{#- Authorized view: analysts read peoplelake_reporting without access to peoplelake_core (SPEC 11.7). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_core') | trim}]) }}
{%- endif %}
{#- Reporting view over the metrics mart. Department cells with headcount below 5 are nulled
    (rpt_metrics_monthly). -#}
select
    s.month,
    s.department_id,
    s.headcount,
    s.fte,
    s.hires,
    s.departures,
    s.workforce_suppressed as is_suppressed
from {{ ref('rpt_metrics_monthly') }} as s
