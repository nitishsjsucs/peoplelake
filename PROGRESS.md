# Build progress

Builder log for the commit plan in SPEC.md section 23. Updated in every commit.

## Position
Commit 3 of 18 (core) done: contracts.

## Done
1. Scaffold: README, SPEC, CONTEXT, LICENSE, tsconfigs (worker, worker tests, node), `wrangler.jsonc` (vars only so far), generated `worker-configuration.d.ts`, `scripts/check-prose.ts`, vitest projects `worker` and `node`.

2. Generator: SplitMix64 PRNG, true world (`world.py`), three source emitters, canonical JSONL, manifest with dataset sha256 pinned for both profiles, oracle (468 rows per profile) and expected R6/R11 results (empty), committed seeds `warehouse/seeds/oracle/*` and `warehouse/seeds/reference/*`, CLI `peoplelake generate`.

3. Contracts: zod contracts in `src/shared/contracts.ts` (three source batches, RawRecord, JobSpec, LoadResult, TransformResult, FaultSpec) generate `contracts/*.schema.json` (`npm run contracts:gen`, checked by a node test); pydantic mirrors in `pipeline/src/peoplelake/contracts.py` with field-by-field schema tests; one valid and one invalid fixture per contract; canonical JSON in TS (`src/worker/ingest/canonical-json.ts`) and Python with a shared golden; every generated envelope (both profiles) validates under pydantic.

## Next
4. Warehouse: DuckDB loader with single-owner UTC connections and canonical digests.

## Check status (last run at this commit)
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run typegen:check` | pass |
| `npm test` | pass (4 files, 42 tests) |
| `npm run check:prose` | pass |
| `npm run test:py` (pytest) | pass (99 tests) |
| `ruff check` | pass |
| `peoplelake generate --profile small --check` | pass |

## Deviations from SPEC.md
- `tsconfig.worker-test.json` holds the worker test project's types (`@cloudflare/vitest-plugin/types`) so `tsconfig.worker.json` keeps `types: []` for source; `npm run typecheck` runs all three configs.
- Prose rules live in `scripts/lib/prose.ts` (pure function, unit tested); `scripts/check-prose.ts` is the CLI.
- `wrangler.jsonc` grows binding by binding as features land instead of declaring every binding in commit 1.
- Generator: extra modules `generator/records.py` (pre-sequencing record type), `generator/dataset.py` (sequencing and files), `generator/seeds.py` and `generator/pins.py`; `peoplelake/paths.py` finds the repo root (`PL_REPO_ROOT` overrides).
- Oracle seed columns: `fte` and `offer_acceptance_rate` are decimal strings with 6 places (empty rate when nobody decided). `ALL` rows carry `transfers_in = transfers_out = ` total transfers in the month. `expected_event_counts.csv` columns are `profile,source,event_type,expected_count`.
- `JobSpec`/`LoadResult`/`TransformResult`: failed and expired results share one smaller shape (`job_id, run_id, attempt, status, error, duration_ms?`) instead of the succeeded shape with optional fields; `FaultSpec` gains `attempt?` (S4 fails the transform on attempt 1 only); `TransformResult.digests` is a partial record (a verify step requires all 10).
- Correction events carry `effectiveDate` = the corrected date for date corrections and the target's date for value corrections; rescinds carry the target's date. The one-event-per-day rule is asserted on business events (hire, rehire, termination, transfer, job and FTE change) for both original and corrected dates.
