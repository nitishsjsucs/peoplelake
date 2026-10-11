{#- Open anomalies (R11). Empty at quiescence on the generated data; non-empty while late data is in flight. -#}
with hris as (
    select * from {{ ref('stg_hris__worker_events') }}
),

business as (
    select event_id from hris
    where event_type in (
        'worker.hired', 'worker.rehired', 'worker.terminated',
        'worker.transferred', 'worker.job_changed', 'worker.fte_changed'
    )
),

spells as (
    select * from {{ ref('int_hris__spells') }}
),

effective as (
    select * from {{ ref('int_hris__effective_events') }}
),

orphan_corrections as (
    select 'orphan_correction' as anomaly_code, h.employee_id as entity_id, h.event_id, h.effective_date
    from hris as h
    where h.event_type = 'worker.event_corrected'
      and not exists (select 1 from business as b where b.event_id = h.corrects_event_id)
),

orphan_rescinds as (
    select 'orphan_rescind' as anomaly_code, h.employee_id as entity_id, h.event_id, h.effective_date
    from hris as h
    where h.event_type = 'worker.event_rescinded'
      and not exists (select 1 from business as b where b.event_id = h.rescinds_event_id)
),

inferred_ends as (
    select 'inferred_spell_end' as anomaly_code, employee_id as entity_id, hire_event_id as event_id, end_date as effective_date
    from spells
    where is_inferred_end
),

missing_prior_spell as (
    select 'rehire_without_prior_spell' as anomaly_code, s.employee_id as entity_id, s.hire_event_id as event_id, s.hire_date as effective_date
    from spells as s
    where s.spell_no > 1
      and not exists (
          select 1 from spells as p where p.employee_id = s.employee_id and p.spell_no = s.spell_no - 1
      )
),

unmatched_terminations as (
    select 'termination_outside_spell' as anomaly_code, e.employee_id as entity_id, e.event_id, e.effective_date
    from effective as e
    where e.event_type = 'worker.terminated'
      and not exists (select 1 from spells as s where s.termination_event_id = e.event_id)
),

changes_outside_spells as (
    select 'hris_change_outside_spell' as anomaly_code, e.employee_id as entity_id, e.event_id, e.effective_date
    from effective as e
    where e.event_type in ('worker.transferred', 'worker.job_changed', 'worker.fte_changed')
      and not exists (
          select 1 from spells as s
          where s.employee_id = e.employee_id
            and e.effective_date > s.hire_date
            and (s.end_date is null or e.effective_date <= s.end_date)
      )
),

talent as (
    select event_id, employee_id, effective_date from {{ ref('stg_talent__compensation_changes') }}
    union all
    select event_id, employee_id, effective_date from {{ ref('stg_talent__reviews') }}
),

talent_outside_spells as (
    select 'talent_event_outside_spell' as anomaly_code, t.employee_id as entity_id, t.event_id, t.effective_date
    from talent as t
    where not exists (
        select 1 from spells as s
        where s.employee_id = t.employee_id
          and t.effective_date >= s.hire_date
          and (s.end_date is null or t.effective_date <= s.end_date)
    )
),

offer_decisions_without_extension as (
    select 'offer_decision_without_extension' as anomaly_code, o.offer_id as entity_id, o.event_id, o.effective_date
    from {{ ref('stg_ats__offers') }} as o
    where o.event_type in ('offer.accepted', 'offer.declined', 'offer.rescinded')
      and not exists (
          select 1 from {{ ref('stg_ats__offers') }} as x
          where x.offer_id = o.offer_id and x.event_type = 'offer.extended'
      )
),

unioned as (
    select * from orphan_corrections
    union all select * from orphan_rescinds
    union all select * from inferred_ends
    union all select * from missing_prior_spell
    union all select * from unmatched_terminations
    union all select * from changes_outside_spells
    union all select * from talent_outside_spells
    union all select * from offer_decisions_without_extension
)

select
    cast(anomaly_code as {{ pl_string() }}) as anomaly_code,
    entity_id,
    event_id,
    effective_date
from unioned
