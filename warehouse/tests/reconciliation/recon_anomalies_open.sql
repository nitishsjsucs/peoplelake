{{ config(severity='warn') }}
{#- R11: no open anomalies (orphan corrections, inferred spell ends, talent events outside spells, ...). -#}
select * from {{ ref('ops_anomalies') }}
