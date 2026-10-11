{#- Restricted: one row per performance review (latest delivery of the review by source_sequence).
    Incremental (merge on review_id) so the policy-tagged table is created once and only merged into
    after that: a `create or replace` on every run would leave `rating` untagged until persist_docs
    tags it again. On BigQuery, `full_refresh: false` keeps replays from recreating it too (SPEC 11.7). -#}
{{ config(
    materialized='incremental',
    incremental_strategy=('merge' if target.type == 'bigquery' else 'delete+insert'),
    unique_key='review_id',
    on_schema_change='fail',
    full_refresh=(false if target.type == 'bigquery' else none),
) }}
select
    review_id,
    employee_id,
    cycle,
    effective_date as review_date,
    rating,
    reviewer_id,
    {{ pl_consumed_load_seq(['talent']) }} as _pl_load_seq
from (
    select
        r.*,
        row_number() over (partition by r.review_id order by r.source_sequence desc nulls last) as recency
    from {{ ref('stg_talent__reviews') }} as r
    {% if pl_is_incremental() %}
    where r.review_id in (
        select n.review_id from {{ ref('stg_talent__reviews') }} as n
        where n._pl_load_seq > (select coalesce(max(c._pl_load_seq), -1) from {{ this }} as c)
    )
    {% endif %}
) as ranked
where recency = 1
  and {{ pl_fault_guard() }}
