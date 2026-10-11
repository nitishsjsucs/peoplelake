{{ config(**pl_bucketed_config(['employee_id'], ['talent'])) }}
{#- On BigQuery a replay must not recreate the policy-tagged table (`create or replace` leaves its
    columns untagged until persist_docs runs): the bucketed incremental path rebuilds what changed. -#}
{{ config(full_refresh=(false if target.type == 'bigquery' else none)) }}
{#- Restricted: compensation history per employee (valid_to exclusive). Bucketed by talent events. -#}
with comp as (
    select
        c.*,
        {{ pl_employee_bucket('c.employee_id') }} as employee_bucket,
        row_number() over (
            partition by c.employee_id, c.effective_date order by c.source_sequence desc nulls last
        ) as day_rank
    from {{ ref('stg_talent__compensation_changes') }} as c
),

scoped as (
    select *
    from comp
    where day_rank = 1
    {% if pl_is_incremental() %}
      and employee_bucket in ({{ pl_affected_buckets(this, ['talent']) }})
    {% endif %}
)

select
    employee_id,
    effective_date as valid_from,
    coalesce(
        lead(effective_date) over (partition by employee_id order by effective_date asc nulls last),
        {{ pl_open_end() }}
    ) as valid_to,
    change_id,
    reason,
    base_salary,
    currency,
    {{ pl_bp_to_pct('bonus_target_bp') }} as bonus_target_pct,
    employee_bucket,
    {{ pl_consumed_load_seq(['talent']) }} as _pl_load_seq
from scoped
where {{ pl_fault_guard() }}
