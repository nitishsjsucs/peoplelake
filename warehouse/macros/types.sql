{#- Exact types only in published models: no FLOAT64 or DOUBLE (SPEC 11.4, 11.8). -#}
{% macro pl_decimal_type() -%}
  {{ return(adapter.dispatch('pl_decimal_type', 'peoplelake')()) }}
{%- endmacro %}
{% macro default__pl_decimal_type() %}decimal(18,6){% endmacro %}
{% macro bigquery__pl_decimal_type() %}numeric{% endmacro %}

{% macro pl_int() -%}{{ dbt.type_bigint() }}{%- endmacro %}

{% macro pl_string() -%}
  {{ return(adapter.dispatch('pl_string', 'peoplelake')()) }}
{%- endmacro %}
{% macro default__pl_string() %}varchar{% endmacro %}
{% macro bigquery__pl_string() %}string{% endmacro %}

{#- Integer basis points to an exact decimal: multiplication keeps DECIMAL (division would give DOUBLE in DuckDB). -#}
{% macro pl_bp_to_decimal(bp) -%}
  cast(cast({{ bp }} as {{ pl_int() }}) * cast(0.0001 as {{ pl_decimal_type() }}) as {{ pl_decimal_type() }})
{%- endmacro %}

{#- Basis points to a percentage (1000 bp = 10.000000). -#}
{% macro pl_bp_to_pct(bp) -%}
  cast(cast({{ bp }} as {{ pl_int() }}) * cast(0.01 as {{ pl_decimal_type() }}) as {{ pl_decimal_type() }})
{%- endmacro %}

{% macro pl_int_div(a, b) -%}
  {{ return(adapter.dispatch('pl_int_div', 'peoplelake')(a, b)) }}
{%- endmacro %}
{% macro default__pl_int_div(a, b) %}(({{ a }}) // ({{ b }})){% endmacro %}
{% macro bigquery__pl_int_div(a, b) %}div({{ a }}, {{ b }}){% endmacro %}

{#- accepted / (accepted + declined) in parts per million, rounded half up, as an exact decimal; null when nobody decided. -#}
{% macro pl_ppm_rate(accepted, total) -%}
  case when cast({{ total }} as {{ pl_int() }}) = 0 then null else
    cast(
      {{ pl_int_div('cast(' ~ accepted ~ ' as ' ~ pl_int() ~ ') * 2000000 + cast(' ~ total ~ ' as ' ~ pl_int() ~ ')',
                    'cast(' ~ total ~ ' as ' ~ pl_int() ~ ') * 2') }}
      * cast(0.000001 as {{ pl_decimal_type() }})
    as {{ pl_decimal_type() }})
  end
{%- endmacro %}

{% macro pl_try_cast(expr, type) -%}
  {{ return(adapter.dispatch('pl_try_cast', 'peoplelake')(expr, type)) }}
{%- endmacro %}
{% macro default__pl_try_cast(expr, type) %}try_cast({{ expr }} as {{ type }}){% endmacro %}
{% macro bigquery__pl_try_cast(expr, type) %}safe_cast({{ expr }} as {{ type }}){% endmacro %}
