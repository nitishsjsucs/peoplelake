select
    cast(department_id as {{ pl_string() }}) as department_id,
    cast(department_name as {{ pl_string() }}) as department_name
from {{ ref('ref_departments') }}
where {{ pl_fault_guard() }}
