// A simulated runner for Workflow tests: claims jobs from the Coordinator and reports results the way the
// Python runner does (metrics artifact first, then the result).
import { env } from "cloudflare:test";
import type { JobSpec } from "../../src/shared/contracts.ts";
import { PUBLISHED_MODELS } from "../../src/shared/metrics.ts";
import { sha256Hex } from "../../src/worker/ingest/canonical-json.ts";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { metricsKey } from "../../src/worker/reports.ts";

export type Outcome = "drop" | Record<string, unknown>;
export type Behaviour = (job: JobSpec) => Promise<Outcome> | Outcome;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadOk(job: JobSpec, o: { rows?: number; rawMax?: number | null; to?: string | null } = {}): Record<string, unknown> {
  const rows = o.rows ?? 10;
  return {
    job_id: job.job_id,
    run_id: job.run_id,
    attempt: job.attempt,
    status: "succeeded",
    lake: {
      table: "peoplelake.raw_events",
      from_snapshot: job.input.from_snapshot,
      to_snapshot: o.to === undefined ? `snap-${job.run_id}` : o.to,
      snapshots_read: rows > 0 ? 1 : 0,
      fallback_full_scan: false,
    },
    rows_read: rows,
    rows_inserted: rows,
    duplicate_deliveries_skipped: 0,
    unique_new_events: rows,
    raw_max_load_seq: o.rawMax === undefined ? job.load_seq : o.rawMax,
    min_effective_date_new: rows > 0 ? "2024-01-01" : null,
    received_histogram_10s: rows > 0 ? [[1790812800, rows]] : [],
    warehouse: "duckdb",
    duration_ms: 5,
  };
}

export async function transformOk(job: JobSpec, o: { checksError?: Record<string, number>; digestSalt?: string } = {}): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ run_id: job.run_id, rows: [] });
  const key = metricsKey(job.run_id);
  const sha = await sha256Hex(body);
  await env.REPORTS_BUCKET.put(key, body);
  const digests: Record<string, string> = {};
  for (const m of PUBLISHED_MODELS) digests[m] = await sha256Hex(`${m}${o.digestSalt ?? ""}`);
  return {
    job_id: job.job_id,
    run_id: job.run_id,
    attempt: job.attempt,
    status: "succeeded",
    dbt: { success: true, models_ok: 27, models_error: 0, tests_pass: 100, tests_warn: 0, tests_error: 0, elapsed_ms: 10 },
    checks: { error: { recon_headcount_roll_forward_company: 0, ...(o.checksError ?? {}) }, warn: {} },
    digests,
    digest_version: 1,
    engine: "duckdb",
    transformed_through_seq: job.load_seq,
    ops_freshness_histogram_10s: [],
    metrics_artifact: { key, sha256: sha, rows: 468 },
    duration_ms: 5,
  };
}

export function failed(job: JobSpec, error = "simulated failure"): Record<string, unknown> {
  return { job_id: job.job_id, run_id: job.run_id, attempt: job.attempt, status: "failed", error };
}

export const happy: Behaviour = async (job) => (job.kind === "load" ? loadOk(job) : transformOk(job));

/** Runs until stop() is called; returns the jobs it claimed in order. */
export function startRunner(behaviour: Behaviour): { stop: () => Promise<JobSpec[]> } {
  const coordinator = coordinatorStub(env);
  const claimed: JobSpec[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const job = await coordinator.claimJob("test-runner");
      if (job === null) {
        await sleep(15);
        continue;
      }
      claimed.push(job);
      const outcome = await behaviour(job);
      if (outcome !== "drop") await coordinator.completeJob(job.job_id, outcome);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return claimed;
    },
  };
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}
