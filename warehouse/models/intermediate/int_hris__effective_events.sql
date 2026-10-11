{#- HRIS business events with corrections applied and rescinded events removed.
    Corrections: for each field, the value from the latest correction (by source_sequence) that sets it.
    Corrections whose target has not arrived are kept aside by ops_anomalies (orphan_correction). -#}
with events as (
    select * from {{ ref('stg_hris__worker_events') }}
),

business as (
    select *
    from events
    where event_type in (
        'worker.hired', 'worker.rehired', 'worker.terminated',
        'worker.transferred', 'worker.job_changed', 'worker.fte_changed'
    )
),

corrections as (
    select
        corrects_event_id as target_event_id,
        {{ pl_last_non_null('corrected_effective_date', 'source_sequence') }} as corrected_effective_date,
        {{ pl_last_non_null('corrected_to_department_id', 'source_sequence') }} as corrected_to_department_id,
        {{ pl_last_non_null('corrected_to_fte_bp', 'source_sequence') }} as corrected_to_fte_bp
    from events
    where event_type = 'worker.event_corrected'
    group by corrects_event_id
),

rescinds as (
    select distinct rescinds_event_id as target_event_id
    from events
    where event_type = 'worker.event_rescinded'
)

select
    b.event_id,
    b.employee_id,
    b.event_type,
    b.source_sequence,
    coalesce(c.corrected_effective_date, b.effective_date) as effective_date,
    b.effective_date as recorded_effective_date,
    b.spell_no,
    b.department_id,
    b.job_code,
    b.location_id,
    b.fte_bp,
    b.ats_candidate_id,
    b.hire_source,
    b.termination_type,
    b.reason_code,
    b.from_department_id,
    coalesce(c.corrected_to_department_id, b.to_department_id) as to_department_id,
    b.from_job_code,
    b.to_job_code,
    b.change_type,
    b.from_fte_bp,
    coalesce(c.corrected_to_fte_bp, b.to_fte_bp) as to_fte_bp,
    c.target_event_id is not null as is_corrected
from business as b
left join corrections as c on c.target_event_id = b.event_id
where not exists (select 1 from rescinds as r where r.target_event_id = b.event_id)
