// Run rows as /api/runs returns them (summary and full). Pure (no bindings), so `npm run bench:ingest`
// times a full 200-run page in Node.
import type { RunRow } from "../orchestration/coordinator-sql.ts";

export const MAX_RUNS_PER_PAGE = 200;

export function summary(r: RunRow): Record<string, unknown> {
  return {
    run_id: r.run_id,
    seq: r.seq,
    mode: r.mode,
    reason: r.reason,
    status: r.status,
    requested_at: r.requested_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    published_at: r.published_at,
    rows_inserted: r.rows_inserted,
    duplicates_skipped: r.duplicates_skipped,
    transform_skipped: r.transform_skipped === 1,
    transform_skip_reason: r.transform_skip_reason,
    load_attempts: r.load_attempts,
    transform_attempts: r.transform_attempts,
    steps_used: r.steps_used,
    error: r.error,
  };
}

export function full(r: RunRow): Record<string, unknown> {
  return {
    ...summary(r),
    load_seq: r.load_seq,
    from_snapshot: r.from_snapshot,
    to_snapshot: r.to_snapshot,
    digests: r.digests_json ? JSON.parse(r.digests_json) : null,
    checks: r.checks_json ? JSON.parse(r.checks_json) : null,
    metrics_key: r.metrics_key,
    landing_through: r.landing_through,
    options: r.options_json ? JSON.parse(r.options_json) : null,
  };
}
