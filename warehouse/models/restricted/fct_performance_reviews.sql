{#- Restricted: one row per performance review. -#}
select
    review_id,
    employee_id,
    cycle,
    effective_date as review_date,
    rating,
    reviewer_id
from (
    select
        r.*,
        row_number() over (partition by r.review_id order by r.source_sequence desc nulls last) as recency
    from {{ ref('stg_talent__reviews') }} as r
) as ranked
where recency = 1
  and {{ pl_fault_guard() }}
