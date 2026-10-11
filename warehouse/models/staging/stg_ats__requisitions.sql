select
    e.event_id,
    e.event_type,
    e.source_sequence,
    e.effective_date,
    {{ pl_json_str('e.payload', 'requisition_id') }} as requisition_id,
    {{ pl_json_str('e.payload', 'department_id') }} as department_id,
    {{ pl_json_str('e.payload', 'job_code') }} as job_code,
    {{ pl_json_str('e.payload', 'close_reason') }} as close_reason
from {{ ref('stg_events') }} as e
where e.source = 'ats'
  and e.event_type in ('requisition.opened', 'requisition.closed')
