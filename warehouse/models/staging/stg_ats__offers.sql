select
    e.event_id,
    e.event_type,
    e.source_sequence,
    e.effective_date,
    {{ pl_json_str('e.payload', 'offer_id') }} as offer_id,
    {{ pl_json_str('e.payload', 'application_id') }} as application_id,
    {{ pl_json_str('e.payload', 'requisition_id') }} as requisition_id,
    {{ pl_json_str('e.payload', 'candidate_id') }} as candidate_id,
    {{ pl_json_date('e.payload', 'proposed_start_date') }} as proposed_start_date,
    {{ pl_json_date('e.payload', 'start_date') }} as start_date
from {{ ref('stg_events') }} as e
where e.source = 'ats'
  and e.event_type in ('offer.extended', 'offer.accepted', 'offer.declined', 'offer.rescinded')
