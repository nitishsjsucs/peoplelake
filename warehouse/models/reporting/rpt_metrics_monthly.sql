{%- if target.type == 'bigquery' -%}
{#- Authorized view: analysts read peoplelake_reporting without access to peoplelake_core (SPEC 11.7). -#}
{{ config(grant_access_to=[{'project': target.project, 'dataset': pl_with_suffix('peoplelake_core') | trim}]) }}
{%- endif %}
{#- The metrics mart with small cells suppressed: the one suppressed read path. The two reporting views
    select from it, and the runner builds the metrics snapshot the Worker serves to viewers from it.
    Offer cells (offers extended, accepted, declined and the rate): primary suppression when a
    department-month (or ALL) has fewer than 5 decisions; secondary suppression when a month has exactly
    one primary department cell while ALL is shown, because ALL minus the other departments would give
    it back: the shown department with the fewest decisions is suppressed too. Workforce cells:
    department-months with headcount below 5. Hires, departures, rehires and transfers are counts of
    employment events with no personal attribute (unlike an offer decision), so their own size does not
    suppress them (SPEC 11.2, fixer). -#}
with m as (
    select * from {{ ref('metrics_workforce_monthly') }}
),

primary_cells as (
    select
        m.*,
        m.offers_accepted + m.offers_declined as decisions,
        m.offers_accepted + m.offers_declined < 5 as offers_primary,
        m.department_id <> 'ALL' and m.headcount < 5 as workforce_suppressed
    from m
),

ranked as (
    select
        p.*,
        sum(case when p.department_id <> 'ALL' and p.offers_primary then 1 else 0 end)
            over (partition by p.month) as primary_departments,
        max(case when p.department_id = 'ALL' and p.offers_primary then 1 else 0 end)
            over (partition by p.month) as all_suppressed,
        row_number() over (
            partition by p.month, case when p.department_id <> 'ALL' and not p.offers_primary then 1 else 0 end
            order by p.decisions asc nulls last, p.department_id asc nulls last
        ) as rank_among_shown
    from primary_cells as p
),

flags as (
    select
        r.*,
        r.offers_primary
        or (
            r.primary_departments = 1
            and r.all_suppressed = 0
            and r.department_id <> 'ALL'
            and r.rank_among_shown = 1
        ) as offers_suppressed
    from ranked as r
)

select
    f.month,
    f.department_id,
    case when not f.workforce_suppressed then f.headcount end as headcount,
    case when not f.workforce_suppressed then f.fte end as fte,
    case when not f.workforce_suppressed then f.hires end as hires,
    case when not f.workforce_suppressed then f.rehires end as rehires,
    case when not f.workforce_suppressed then f.departures end as departures,
    case when not f.workforce_suppressed then f.transfers_in end as transfers_in,
    case when not f.workforce_suppressed then f.transfers_out end as transfers_out,
    case when not f.offers_suppressed then f.offers_extended end as offers_extended,
    case when not f.offers_suppressed then f.offers_accepted end as offers_accepted,
    case when not f.offers_suppressed then f.offers_declined end as offers_declined,
    case when not f.offers_suppressed then f.offer_acceptance_rate end as offer_acceptance_rate,
    f.workforce_suppressed,
    f.offers_suppressed
from flags as f
