{#- Eval-only fault injection (SPEC 8.4): when PL_FAULT_FAIL_MODEL names this model, its SQL raises at
    run time (DuckDB error(), BigQuery ERROR()); otherwise the guard is a no-op predicate. -#}
{% macro pl_fault_guard() -%}
  {%- set target_model = env_var('PL_FAULT_FAIL_MODEL', '') | trim -%}
  {%- if target_model and target_model == this.identifier -%}
    ((select {{ adapter.dispatch('pl_error_fn', 'peoplelake')() }}('peoplelake fault injected in {{ this.identifier }}')) is null)
  {%- else -%}
    (1 = 1)
  {%- endif -%}
{%- endmacro %}
{% macro default__pl_error_fn() %}error{% endmacro %}
{% macro bigquery__pl_error_fn() %}ERROR{% endmacro %}
