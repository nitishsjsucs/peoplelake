{#- Employees active on a date with their attributes, from the SCD2 history (valid_to is exclusive). -#}
{% macro pl_employee_as_of(as_of_date) -%}
  select h.*
  from {{ ref('dim_employee_history') }} as h
  where h.valid_from <= cast({{ as_of_date }} as date)
    and h.valid_to > cast({{ as_of_date }} as date)
{%- endmacro %}
