{#- Offer acceptance by decision month and requisition department. Cells with fewer than 5 decisions are nulled. -#}
select
    m.month,
    m.department_id,
    m.offers_extended,
    case when m.offers_accepted + m.offers_declined >= 5 then m.offers_accepted end as offers_accepted,
    case when m.offers_accepted + m.offers_declined >= 5 then m.offers_declined end as offers_declined,
    case when m.offers_accepted + m.offers_declined >= 5 then m.offer_acceptance_rate end as offer_acceptance_rate,
    m.offers_accepted + m.offers_declined < 5 as is_suppressed
from {{ ref('metrics_workforce_monthly') }} as m
