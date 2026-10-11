{%- if target.type == 'bigquery' -%}
{#- Authorized view on peoplelake_restricted: the analyst reads this dataset only. Column-level policy
    tags still apply through the view (masked compensation, null ratings for peoplelake-analyst). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_restricted') | trim}]) }}
{%- endif %}
select
    c.employee_id,
    c.valid_from,
    c.valid_to,
    c.change_id,
    c.reason,
    c.base_salary,
    c.currency,
    c.bonus_target_pct
from {{ ref('fct_compensation_history') }} as c
