{{ config(**pl_bucketed_config(['employee_id'], ['hris'])) }}
{#- SCD2 employment history (ADR 0004): incremental runs rebuild whole employee buckets touched by HRIS
    events newer than this model's own cursor, emitting complete histories for those employees. -#}
with timeline as (
    select t.*
    from {{ ref('int_hris__attribute_timeline') }} as t
    {% if pl_is_incremental() %}
    where t.employee_bucket in ({{ pl_affected_buckets(this, ['hris']) }})
    {% endif %}
)

select
    employee_id,
    spell_no,
    valid_from,
    valid_to,
    department_id,
    job_code,
    location_id,
    {{ pl_bp_to_decimal('fte_bp') }} as fte,
    cast('active' as {{ pl_string() }}) as employment_status,
    valid_to = {{ pl_open_end() }} as is_current,
    employee_bucket,
    {{ pl_consumed_load_seq(['hris']) }} as _pl_load_seq
from timeline
where {{ pl_fault_guard() }}
