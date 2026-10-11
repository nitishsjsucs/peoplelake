{%- if target.type == 'bigquery' -%}
{#- Authorized view on peoplelake_restricted: the analyst reads this dataset only. Column-level policy
    tags still apply through the view (masked compensation, null ratings for peoplelake-analyst). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_restricted') | trim}]) }}
{%- endif %}
select
    r.review_id,
    r.employee_id,
    r.cycle,
    r.review_date,
    r.rating,
    r.reviewer_id
from {{ ref('fct_performance_reviews') }} as r
