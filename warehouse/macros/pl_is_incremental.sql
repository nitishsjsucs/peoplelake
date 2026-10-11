{#- is_incremental() needs a live connection. The offline BigQuery compile in CI sets
    pl_offline_compile (full-build branch) or also pl_force_incremental_compile (incremental branch). -#}
{% macro pl_is_incremental() -%}
  {%- if var('pl_offline_compile', false) -%}
    {{ return(var('pl_force_incremental_compile', false)) }}
  {%- endif -%}
  {{ return(is_incremental()) }}
{%- endmacro %}
