{#- JSON payload access: DuckDB json_extract_string, BigQuery JSON_VALUE. A JSON null gives SQL NULL on both. -#}
{% macro pl_json_str(column, path) -%}
  {{ return(adapter.dispatch('pl_json_str', 'peoplelake')(column, path)) }}
{%- endmacro %}
{% macro default__pl_json_str(column, path) %}json_extract_string({{ column }}, '$.{{ path }}'){% endmacro %}
{% macro bigquery__pl_json_str(column, path) %}json_value({{ column }}, '$.{{ path }}'){% endmacro %}

{% macro pl_json_int(column, path) -%}
  cast({{ pl_json_str(column, path) }} as {{ pl_int() }})
{%- endmacro %}

{% macro pl_json_date(column, path) -%}
  cast({{ pl_json_str(column, path) }} as date)
{%- endmacro %}

{#- Value of the latest row (by order_col) where expr is not null, as an aggregate. -#}
{% macro pl_last_non_null(expr, order_col) -%}
  {{ return(adapter.dispatch('pl_last_non_null', 'peoplelake')(expr, order_col)) }}
{%- endmacro %}
{% macro default__pl_last_non_null(expr, order_col) -%}
  arg_max({{ expr }}, {{ order_col }}) filter (where {{ expr }} is not null)
{%- endmacro %}
{% macro bigquery__pl_last_non_null(expr, order_col) -%}
  array_agg({{ expr }} ignore nulls order by {{ order_col }} desc nulls last limit 1)[safe_offset(0)]
{%- endmacro %}
