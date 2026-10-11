select
    e.event_id,
    e.event_type,
    e.source_sequence,
    e.effective_date,
    {{ pl_json_str('e.payload', 'application_id') }} as application_id,
    {{ pl_json_str('e.payload', 'requisition_id') }} as requisition_id,
    {{ pl_json_str('e.payload', 'candidate_id') }} as candidate_id,
    {{ pl_json_str('e.payload', 'from_stage') }} as from_stage,
    {{ pl_json_str('e.payload', 'to_stage') }} as to_stage
from {{ ref('stg_events') }} as e
where e.source = 'ats'
  and e.event_type in ('application.submitted', 'application.stage_changed')
