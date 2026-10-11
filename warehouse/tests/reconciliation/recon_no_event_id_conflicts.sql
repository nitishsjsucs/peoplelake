{{ config(severity='error') }}
{#- R8: every delivery of an event carries the same payload (one payload_sha256 per event_id). -#}
select event_id, count(distinct payload_sha256) as payload_versions
from {{ source('pl_raw', 'raw_event_deliveries') }}
group by event_id
having count(distinct payload_sha256) > 1
