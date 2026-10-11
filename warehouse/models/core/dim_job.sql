select
    cast(job_code as {{ pl_string() }}) as job_code,
    cast(job_title as {{ pl_string() }}) as job_title,
    cast(job_family as {{ pl_string() }}) as job_family,
    cast(job_level as {{ pl_int() }}) as job_level
from {{ ref('ref_jobs') }}
where {{ pl_fault_guard() }}
