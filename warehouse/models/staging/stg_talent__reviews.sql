select
    e.event_id,
    e.entity_id as employee_id,
    e.source_sequence,
    e.effective_date,
    {{ pl_json_str('e.payload', 'review_id') }} as review_id,
    {{ pl_json_str('e.payload', 'cycle') }} as cycle,
    {{ pl_json_int('e.payload', 'rating') }} as rating,
    {{ pl_json_str('e.payload', 'reviewer_id') }} as reviewer_id
from {{ ref('stg_events') }} as e
where e.source = 'talent'
  and e.event_type = 'review.submitted'
