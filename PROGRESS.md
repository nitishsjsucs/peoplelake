# Build progress

Builder log for the commit plan in SPEC.md section 23. Updated in every commit.

## Position
Commit 1 of 18 (core) done: scaffold.

## Done
1. Scaffold: README, SPEC, CONTEXT, LICENSE, tsconfigs (worker, worker tests, node), `wrangler.jsonc` (vars only so far), generated `worker-configuration.d.ts`, `scripts/check-prose.ts`, vitest projects `worker` and `node`.

## Next
2. Generator: deterministic synthetic world with exact counts, oracle, committed oracle seeds.

## Check status (last run at this commit)
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run typegen:check` | pass |
| `npm test` | pass (2 files, 4 tests) |
| `npm run check:prose` | pass |

## Deviations from SPEC.md
- `tsconfig.worker-test.json` holds the worker test project's types (`@cloudflare/vitest-plugin/types`) so `tsconfig.worker.json` keeps `types: []` for source; `npm run typecheck` runs all three configs.
- Prose rules live in `scripts/lib/prose.ts` (pure function, unit tested); `scripts/check-prose.ts` is the CLI.
- `wrangler.jsonc` grows binding by binding as features land instead of declaring every binding in commit 1.
