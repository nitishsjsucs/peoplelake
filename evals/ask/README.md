# Ask eval questions

`questions.jsonl` holds 60 hand-written questions, 12 per metric, each with the one `MetricQuery` an analyst would expect. `peoplelake eval ask` sends every question to the Worker's `POST /api/ask/query` (the translation step of `/api/ask`, without the snapshot lookup) and scores the returned query against the expected one: exact match on all four fields, accuracy per field, invalid answers (the provider produced no valid query) and latency.

The questions were written before any provider was run against them, and the providers were not changed afterwards to fit them. Accuracy numbers in the README come only from `evals/results/ask-*.json`.

## Labeling conventions

The expected query follows the conventions stated in the Worker's system prompt, plus the plain reading of a few common phrasings:

| Phrase in the question | Expected months |
|---|---|
| no period | `2023-01` to `2025-12` (the whole window) |
| a year, for example "in 2024" or "during 2024" | `2024-01` to `2024-12` |
| a quarter, for example "Q3 2024" | `2024-07` to `2024-09` |
| first half or second half of a year | `01` to `06`, or `07` to `12` |
| one named month, for example "June 2023" | `2023-06` to `2023-06` |
| "at the end of 2024", "at year-end 2023" | the December of that year only |
| "from A to B", "between A and B", "A through B" | `A` to `B` inclusive |
| "since July 2025" | `2025-07` to `2025-12` (the end of the window) |

Departments are named as in `ref_departments.csv` (Engineering, Product, Design, Sales, Marketing, Customer Success, Finance, People, Legal, Operations, Data, Security), sometimes by id (`D05`). "The whole company", "company-wide", "across all departments" and questions with no department mean `ALL`. "Hires" counts hires and rehires; "attrition", "turnover", "leavers", "exits" and "terminations" mean departures.
