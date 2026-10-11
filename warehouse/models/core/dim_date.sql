with spine as (
    {{ pl_date_spine('2010-01-01', '2026-12-31') }}
)

select
    date_day,
    {{ pl_month_start('date_day') }} as month_start,
    {{ pl_month_end('date_day') }} as month_end,
    cast(extract(year from date_day) as {{ pl_int() }}) as year_number,
    cast(extract(month from date_day) as {{ pl_int() }}) as month_number,
    date_day = {{ pl_month_end('date_day') }} as is_month_end
from spine
