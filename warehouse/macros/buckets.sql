{#- Employee buckets (ADR 0004): effective-dated models are rebuilt per bucket of employees. -#}
{% macro pl_bucket_count() %}2048{% endmacro %}

{% macro pl_employee_bucket(employee_id) -%}
  mod(cast(substr({{ employee_id }}, 2) as {{ pl_int() }}), {{ pl_bucket_count() }})
{%- endmacro %}

{#- Buckets of employees with HRIS or talent events newer than this model's own cursor: the max
    _pl_load_seq stamped on its rows. A model that failed in an earlier attempt keeps its old cursor
    and catches up on the next one, even if upstream models already advanced theirs. -#}
{% macro pl_affected_buckets(cursor_relation, sources) -%}
  select distinct {{ pl_employee_bucket('e.entity_id') }} as employee_bucket
  from {{ ref('stg_events') }} as e
  where e.source in ({% for s in sources %}'{{ s }}'{% if not loop.last %}, {% endif %}{% endfor %})
    and e._pl_load_seq > (select coalesce(max(c._pl_load_seq), -1) from {{ cursor_relation }} as c)
{%- endmacro %}

{#- The cursor value a bucketed model stamps on the rows it writes. -#}
{% macro pl_consumed_load_seq(sources) -%}
  (select coalesce(max(e._pl_load_seq), -1) from {{ ref('stg_events') }} as e
   where e.source in ({% for s in sources %}'{{ s }}'{% if not loop.last %}, {% endif %}{% endfor %}))
{%- endmacro %}

{#- Pre-hook of every bucketed model: delete all affected buckets first. Both delete+insert and
    insert_overwrite replace only the buckets present in the new rows, so a bucket whose correct state is
    now empty (an employee terminated before the first month end of the window) would otherwise keep
    stale rows. If the model then fails, the deleted buckets still hold events above the cursor, so the
    next attempt rebuilds them. -#}
{% macro pl_bucket_pre_delete(sources) -%}
  {%- if pl_is_incremental() -%}
    delete from {{ this }} where employee_bucket in ({{ pl_affected_buckets(this, sources) }})
  {%- endif -%}
{%- endmacro %}

{#- Bucketed replace: DuckDB delete+insert keyed on employee_bucket; BigQuery insert_overwrite on an
    int64 range partition (dbt-bigquery accepts only merge, insert_overwrite and microbatch). -#}
{% macro pl_bucketed_config(cluster_by, sources) -%}
  {%- set pre_delete = "{{ pl_bucket_pre_delete(" ~ (sources | tojson) ~ ") }}" -%}
  {%- if target.type == 'bigquery' -%}
    {{ return({
      'materialized': 'incremental',
      'incremental_strategy': 'insert_overwrite',
      'partition_by': {'field': 'employee_bucket', 'data_type': 'int64',
                       'range': {'start': 0, 'end': 2048, 'interval': 1}},
      'cluster_by': cluster_by,
      'on_schema_change': 'fail',
      'pre_hook': [pre_delete]
    }) }}
  {%- else -%}
    {{ return({
      'materialized': 'incremental',
      'incremental_strategy': 'delete+insert',
      'unique_key': 'employee_bucket',
      'on_schema_change': 'fail',
      'pre_hook': [pre_delete]
    }) }}
  {%- endif -%}
{%- endmacro %}
