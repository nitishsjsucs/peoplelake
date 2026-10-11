{%- if target.type == 'bigquery' -%}
{#- Authorized view: analysts read peoplelake_reporting without access to peoplelake_core (SPEC 11.7). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_core') | trim}]) }}
{%- endif %}
{#- Offer acceptance by decision month and requisition department, with the primary and secondary
    suppression of rpt_metrics_monthly (fewer than 5 decisions, and never exactly one hidden cell). -#}
select
    s.month,
    s.department_id,
    s.offers_extended,
    s.offers_accepted,
    s.offers_declined,
    s.offer_acceptance_rate,
    s.offers_suppressed as is_suppressed
from {{ ref('rpt_metrics_monthly') }} as s
