// Read and control interface for people and the runner (SPEC 7.3).
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { coordinatorStub, type RunOptions } from "../orchestration/coordinator.ts";
import type { RunRow } from "../orchestration/coordinator-sql.ts";
import { LATEST_METRICS_KEY } from "../reports.ts";
import { parseWindow, summarizeFreshness } from "./freshness.ts";

export const MAX_RUNS_PER_PAGE = 200;

function summary(r: RunRow): Record<string, unknown> {
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

function full(r: RunRow): Record<string, unknown> {
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

export function mountPublicApi(app: App): void {
  // At most 200 runs per page (SPEC 29.4.8: a page of parsed runs must stay well inside 10 ms of CPU).
  // Without `since`: the newest first. With `since=<epoch ms>`: runs started at or after it, oldest
  // first, so a client pages forward with the last run's started_at.
  app.get("/api/runs", requireRole("viewer", "runner", "operator"), async (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const sinceRaw = c.req.query("since");
    if (sinceRaw !== undefined && !/^\d{1,15}$/.test(sinceRaw)) return c.json({ error: "invalid_since" }, 400);
    const format = c.req.query("format") === "full" ? full : summary;
    const runs = await coordinatorStub(c.env).listRuns(Number.isFinite(limit) ? Math.min(limit, MAX_RUNS_PER_PAGE) : 50, sinceRaw === undefined ? null : Number(sinceRaw));
    return c.json({ runs: runs.map(format), max_per_page: MAX_RUNS_PER_PAGE });
  });

  app.get("/api/runs/:run_id", requireRole("viewer", "runner", "operator"), async (c) => {
    const found = await coordinatorStub(c.env).getRun(c.req.param("run_id"));
    if (found === null) return c.json({ error: "not_found" }, 404);
    return c.json({
      run: full(found.run),
      jobs: found.jobs.map((j) => ({ ...j, result_json: undefined, result: j.result_json ? JSON.parse(j.result_json) : null })),
    });
  });

  app.post("/api/runs", requireRole("operator"), async (c) => {
    return c.json(await coordinatorStub(c.env).requestRun("manual"), 202);
  });

  app.post("/api/replay", requireRole("operator"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { to_snapshot?: unknown; dataset_suffix?: unknown };
    const options: RunOptions = {};
    if (typeof body.to_snapshot === "string" && /^\d+$/.test(body.to_snapshot)) options.to_snapshot = body.to_snapshot;
    if (typeof body.dataset_suffix === "string") {
      if (!/^[a-z0-9_]{1,20}$/.test(body.dataset_suffix)) return c.json({ error: "invalid_dataset_suffix" }, 422);
      options.dataset_suffix = body.dataset_suffix;
    }
    return c.json(await coordinatorStub(c.env).requestRun(options.dataset_suffix ? "replay-scratch" : "replay", "replay", Date.now(), options), 202);
  });

  app.get("/api/status", requireRole("viewer", "runner", "operator"), async (c) => {
    return c.json(await coordinatorStub(c.env).status());
  });

  app.get("/api/metrics/latest", requireRole("viewer", "operator"), async (c) => {
    const obj = await c.env.REPORTS_BUCKET.get(LATEST_METRICS_KEY);
    if (obj === null) return c.json({ error: "no_committed_metrics" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/json" } });
  });

  app.get("/api/freshness", requireRole("viewer", "operator"), async (c) => {
    const window = c.req.query("window") ?? "24h";
    const since = Date.now() - parseWindow(window);
    const rows = await coordinatorStub(c.env).freshnessRows(Math.floor(since));
    const byRun = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.published_by === null) continue;
      byRun.set(r.published_by, [...(byRun.get(r.published_by) ?? []), r]);
    }
    return c.json({
      window,
      method: "ledger histograms (10 s buckets of first receipt) against run published_at",
      overall: summarizeFreshness(rows),
      runs: [...byRun.entries()].map(([runId, rs]) => ({ run_id: runId, ...summarizeFreshness(rs) })),
      buckets: rows,
    });
  });
}
