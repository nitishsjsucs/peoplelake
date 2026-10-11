{{ config(severity='warn') }}
{#- R6: each accepted offer starting by data_as_of has exactly one hire or rehire for its candidate within
    30 days of the start; each in-window hire has exactly one accepted offer. -#}
with offers as (
    select * from {{ ref('fct_offers') }} where final_status = 'accepted'
),

hires as (
    select * from {{ ref('int_hris__spells') }} where ats_candidate_id is not null
),

offer_side as (
    select o.offer_id as entity_id, 'accepted offer without exactly one hire' as problem
    from offers as o
    left join hires as h
        on h.ats_candidate_id = o.candidate_id
        and abs({{ pl_days_between('o.start_date', 'h.hire_date') }}) <= 30
    where o.start_date <= cast('{{ var("pl_data_as_of") }}' as date)
    group by o.offer_id
    having count(h.employee_id) <> 1
),

hire_side as (
    select h.employee_id as entity_id, 'in-window hire without exactly one accepted offer' as problem
    from hires as h
    left join offers as o on o.candidate_id = h.ats_candidate_id
    group by h.employee_id, h.spell_no
    having count(o.offer_id) <> 1
)

select * from offer_side
union all
select * from hire_side
