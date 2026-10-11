{#- dbt's cross-database date macros return engine-specific types (TIMESTAMP, DATETIME), so they are
    only used through these wrappers, which always return DATE (SPEC 11.8). -#}
{% macro pl_month_start(d) -%}
  cast({{ dbt.date_trunc('month', d) }} as date)
{%- endmacro %}

{% macro pl_month_end(d) -%}
  cast({{ dbt.last_day(d, 'month') }} as date)
{%- endmacro %}

{% macro pl_add_days(d, n) -%}
  cast({{ dbt.dateadd('day', n, d) }} as date)
{%- endmacro %}

{% macro pl_add_months(d, n) -%}
  cast({{ dbt.dateadd('month', n, d) }} as date)
{%- endmacro %}

{% macro pl_days_between(a, b) -%}
  {{ dbt.datediff(a, b, 'day') }}
{%- endmacro %}

{% macro pl_open_end() -%}
  cast('9999-12-31' as date)
{%- endmacro %}

{#- One row per day between two date literals (inclusive): DuckDB range, BigQuery GENERATE_DATE_ARRAY. -#}
{% macro pl_date_spine(start_date, end_date) -%}
  {{ return(adapter.dispatch('pl_date_spine', 'peoplelake')(start_date, end_date)) }}
{%- endmacro %}
{% macro default__pl_date_spine(start_date, end_date) %}
  select cast(d as date) as date_day
  from range(cast('{{ start_date }}' as date), cast('{{ end_date }}' as date) + interval 1 day, interval 1 day) as t(d)
{% endmacro %}
{% macro bigquery__pl_date_spine(start_date, end_date) %}
  select date_day
  from unnest(generate_date_array(date '{{ start_date }}', date '{{ end_date }}', interval 1 day)) as date_day
{% endmacro %}
