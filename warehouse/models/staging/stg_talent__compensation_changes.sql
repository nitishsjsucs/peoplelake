select
    e.event_id,
    e.entity_id as employee_id,
    e.source_sequence,
    e.effective_date,
    e._pl_load_seq,
    {{ pl_json_str('e.payload', 'change_id') }} as change_id,
    {{ pl_json_str('e.payload', 'reason') }} as reason,
    {{ pl_json_int('e.payload', 'base_salary') }} as base_salary,
    {{ pl_json_str('e.payload', 'currency') }} as currency,
    {{ pl_json_int('e.payload', 'bonus_target_bp') }} as bonus_target_bp
from {{ ref('stg_events') }} as e
where e.source = 'talent'
  and e.event_type = 'compensation.changed'
