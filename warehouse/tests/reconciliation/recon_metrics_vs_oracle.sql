{{ config(severity='warn') }}
{#- R10: all five metrics and their components equal the oracle (computed by the generator from the true
    world, never from events) for all 468 rows of var('pl_profile'). -#}
with metrics as (
    select * from {{ ref('metrics_workforce_monthly') }}
),

oracle as (
    select * from {{ ref('oracle_workforce_monthly') }}
    where profile = '{{ var("pl_profile") }}'
)

select
    coalesce(m.month, o.month) as month,
    coalesce(m.department_id, o.department_id) as department_id
from metrics as m
full outer join oracle as o on o.month = m.month and o.department_id = m.department_id
where m.month is null
   or o.month is null
   or m.headcount <> o.headcount
   or m.fte <> o.fte
   or m.hires <> o.hires
   or m.rehires <> o.rehires
   or m.departures <> o.departures
   or m.transfers_in <> o.transfers_in
   or m.transfers_out <> o.transfers_out
   or m.offers_extended <> o.offers_extended
   or m.offers_accepted <> o.offers_accepted
   or m.offers_declined <> o.offers_declined
   or (m.offer_acceptance_rate is null) <> (o.offer_acceptance_rate is null)
   or m.offer_acceptance_rate <> o.offer_acceptance_rate
