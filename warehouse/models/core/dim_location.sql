select
    cast(location_id as {{ pl_string() }}) as location_id,
    cast(location_name as {{ pl_string() }}) as location_name,
    cast(country_code as {{ pl_string() }}) as country_code
from {{ ref('ref_locations') }}
