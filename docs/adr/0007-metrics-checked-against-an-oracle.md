# ADR 0007: Metrics are checked against an oracle

Status: accepted (2026-10-10)

## Decision
The generator keeps the true world (spells with true dates, true attribute timelines, offers) and computes the expected value of every metric for every month and department from it, never from the events. Both profiles' oracles are committed as dbt seeds and a test regenerates and diffs them. R10 compares the warehouse's metrics to the oracle exactly (all five metrics and their components on all 468 rows). The generator also proves that the expected results of R6 and R11 are empty on the true world.

## Consequences
A modeling bug cannot hide behind self-consistent SQL: the warehouse must reproduce numbers computed by an independent path.
