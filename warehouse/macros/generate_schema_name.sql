{#- Custom schemas map to pl_staging, pl_core, pl_restricted, pl_reporting, pl_ops (the same names in
    DuckDB and BigQuery), plus `_<suffix>` when PL_DATASET_SUFFIX is set (always `drill` for prod-drill). -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- set base = custom_schema_name if custom_schema_name is not none else target.schema -%}
  {{ pl_with_suffix(base | trim) }}
{%- endmacro %}

{% macro pl_dataset_suffix() -%}
  {{ return(env_var('PL_DATASET_SUFFIX', '') | trim) }}
{%- endmacro %}

{% macro pl_with_suffix(base) -%}
  {%- set suffix = pl_dataset_suffix() -%}
  {%- if suffix and not base.endswith('_' ~ suffix) -%}{{ base }}_{{ suffix }}{%- else -%}{{ base }}{%- endif -%}
{%- endmacro %}
