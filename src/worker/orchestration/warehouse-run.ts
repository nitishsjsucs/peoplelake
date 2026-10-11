// WarehouseRunWorkflow (SPEC 8.2): open-run -> load attempts -> transform attempts (or a transform skip)
// -> verify -> commit -> release. Work is handed to a runner through attempt-scoped jobs and
// step.waitForEvent on `<kind>-result-a<n>`, so a stale result from attempt 1 can never satisfy the
// wait for attempt 2. Any failure records the error, releases the single-flight slot and rethrows.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { PUBLISHED_MODELS } from "../../shared/metrics.ts";
import { parseConfig } from "../config.ts";
import { sha256Hex } from "../ingest/canonical-json.ts";
import { publishLatestMetrics, writeRunReport } from "../reports.ts";
import { type CommitInput, coordinatorStub, type RunParams, type RunPlan } from "./coordinator.ts";
import { makeDispatcher } from "./dispatcher.ts";
import type { TokenCache } from "./gcp-token.ts";

type JobResult = Record<string, unknown> & { status: string };

interface LoadOk extends JobResult {
  status: "succeeded";
  rows_inserted: number;
  duplicate_deliveries_skipped: number;
  raw_max_load_seq: number | null;
  lake: { from_snapshot: string | null; to_snapshot: string | null };
}

interface TransformOk extends JobResult {
  status: "succeeded";
  dbt: { success: boolean; tests_error: number };
  checks: { error: Record<string, number>; warn: Record<string, number> };
  digests: Record<string, string>;
  transformed_through_seq: number;
  metrics_artifact: { key: string; sha256: string; rows: number };
}

export interface RunOutput {
  run_id: string;
  status: "committed";
  transform_skipped: boolean;
  rows_inserted: number;
  load_attempts: number;
  transform_attempts: number;
}

const MAX_WAIT_ROUNDS = 20;

/** A run that cannot succeed. Thrown outside steps so the catch path can record it and release the slot
 * (a NonRetryableError makes the engine abort the instance before those steps run). */
export class RunFailure extends Error {
  override name = "RunFailure";
}

type Verdict = { ok: true; skipped: boolean } | { ok: false; reason: string };

export function shouldSkipTransform(plan: Pick<RunPlan, "mode" | "transformed_through_seq">, load: Pick<LoadOk, "rows_inserted" | "raw_max_load_seq">): boolean {
  return plan.mode === "incremental" && load.rows_inserted === 0 && (load.raw_max_load_seq ?? -1) <= (plan.transformed_through_seq ?? -1);
}

export class WarehouseRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<RunOutput> {
    const runId = event.payload.run_id;
    const coordinator = coordinatorStub(this.env);
    try {
      const plan = await step.do("open-run", async () => coordinator.openRun(runId));

      const scratch = plan.options.dataset_suffix !== undefined;
      const extra = {
        ...(plan.options.to_snapshot !== undefined ? { to_snapshot: plan.options.to_snapshot } : {}),
        ...(plan.options.dataset_suffix !== undefined ? { dataset_suffix: plan.options.dataset_suffix } : {}),
      };
      const loadRun = await this.#job(step, plan, "load", { from_snapshot: plan.from_snapshot, full_refresh: false, ...extra });
      const load = loadRun.result as LoadOk;

      const skip = shouldSkipTransform(plan, load);
      let transform: TransformOk | null = null;
      let transformAttempts = 0;
      if (!skip) {
        const t = await this.#job(step, plan, "transform", {
          from_snapshot: plan.from_snapshot,
          full_refresh: plan.mode === "replay",
          ...extra,
        });
        transform = t.result as TransformOk;
        transformAttempts = t.attempts;
      }

      const verdict = await step.do("verify", { retries: { limit: 2, delay: "1 second", backoff: "constant" } }, async () =>
        this.#verify(plan, transform, skip),
      );
      if (!verdict.ok) throw new RunFailure(`verify: ${verdict.reason}`);

      const commit: CommitInput = {
        from_snapshot: plan.from_snapshot,
        to_snapshot: load.lake.to_snapshot ?? plan.previous.to_snapshot,
        transformed_through_seq: transform ? transform.transformed_through_seq : null,
        rows_inserted: load.rows_inserted,
        duplicates_skipped: load.duplicate_deliveries_skipped,
        transform_skipped: skip,
        digests: transform ? transform.digests : plan.previous.digests,
        checks: transform ? transform.checks : null,
        metrics_key: transform ? transform.metrics_artifact.key : plan.previous.metrics_key,
      };
      await step.do("commit", { retries: { limit: 5, delay: "1 second", backoff: "exponential" } }, async () => {
        if (await coordinator.consumeCommitFault(runId)) throw new Error("eval fault: commit_step_error");
        const result = await coordinator.commitRun(runId, commit);
        await writeRunReport(this.env, runId, { run_id: runId, plan, load, transform, commit, committed: result });
        if (transform && !scratch) await publishLatestMetrics(this.env, transform.metrics_artifact.key);
        return result;
      });
      await step.do("release", async () => {
        await coordinator.releaseRun(runId);
        return true;
      });
      return {
        run_id: runId,
        status: "committed",
        transform_skipped: skip,
        rows_inserted: load.rows_inserted,
        load_attempts: loadRun.attempts,
        transform_attempts: transformAttempts,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do("fail-run", async () => coordinator.failRun(runId, message));
      await step.do("release-after-failure", async () => {
        await coordinator.releaseRun(runId);
        return true;
      });
      throw err;
    }
  }

  async #job(
    step: WorkflowStep,
    plan: RunPlan,
    kind: "load" | "transform",
    input: { from_snapshot: string | null; full_refresh: boolean; to_snapshot?: string; dataset_suffix?: string },
  ): Promise<{ result: JobResult; attempts: number }> {
    const coordinator = coordinatorStub(this.env);
    for (let attempt = 1; attempt <= plan.max_attempts; attempt++) {
      const dispatched = await step.do(
        `dispatch:${kind}:a${attempt}`,
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          const spec = await coordinator.enqueueJob(plan.run_id, kind, attempt, input);
          if (!(await coordinator.shouldDispatch())) return { job_id: spec.job_id, dispatched: false, ref: null };
          const config = parseConfig(this.env as unknown as Record<string, unknown>, null);
          const tokens: TokenCache = { get: () => coordinator.getGcpToken(), set: (t) => coordinator.setGcpToken(t) };
          const result = await makeDispatcher(config, this.env, tokens).dispatch();
          await coordinator.noteDispatch(spec.job_id, result.ref ?? null);
          return { job_id: spec.job_id, dispatched: result.mode === "cloudrun", ref: result.ref ?? null };
        },
      );
      const result = await this.#awaitResult(step, plan, kind, attempt, dispatched.job_id);
      if (result.status === "succeeded") return { result, attempts: attempt };
    }
    throw new RunFailure(`${kind} did not succeed in ${plan.max_attempts} attempts`);
  }

  async #awaitResult(step: WorkflowStep, plan: RunPlan, kind: string, attempt: number, jobId: string): Promise<JobResult> {
    const coordinator = coordinatorStub(this.env);
    const type = `${kind}-result-a${attempt}`;
    for (let round = 1; round <= MAX_WAIT_ROUNDS; round++) {
      const name = round === 1 ? `wait:${kind}:a${attempt}` : `wait:${kind}:a${attempt}:r${round}`;
      try {
        const event = await step.waitForEvent(name, { type, timeout: `${plan.wait_timeout_seconds} seconds` });
        return event.payload as JobResult;
      } catch {
        // The wait timed out: the job finished without a delivered event, is still running under a live
        // lease (heartbeats), or is expired now by the Coordinator.
        const resolution = await step.do(`check:${kind}:a${attempt}:r${round}`, async () => coordinator.resolveWait(jobId));
        if (resolution.state === "done") return JSON.parse(resolution.result_json) as JobResult;
      }
    }
    return { status: "expired", error: "gave up waiting for a result" };
  }

  async #verify(plan: RunPlan, transform: TransformOk | null, skip: boolean): Promise<Verdict> {
    if (skip) return { ok: true, skipped: true };
    if (transform === null) return { ok: false, reason: "no transform result" };
    if (!transform.dbt.success) return { ok: false, reason: "dbt build did not succeed" };
    if (transform.dbt.tests_error !== 0) return { ok: false, reason: `${transform.dbt.tests_error} error-level tests failed` };
    const failing = Object.entries(transform.checks.error).filter(([, n]) => n !== 0);
    if (failing.length > 0) return { ok: false, reason: `error-level checks failed: ${failing.map(([k]) => k).join(", ")}` };
    const missing = PUBLISHED_MODELS.filter((m) => !transform.digests[m]);
    if (missing.length > 0) return { ok: false, reason: `missing digests for ${missing.join(", ")}` };
    if (!transform.metrics_artifact.key.includes(plan.run_id)) return { ok: false, reason: "metrics artifact belongs to another run" };
    const artifact = await this.env.REPORTS_BUCKET.get(transform.metrics_artifact.key);
    if (artifact === null) return { ok: false, reason: `metrics artifact ${transform.metrics_artifact.key} not found` };
    const sha = await sha256Hex(await artifact.text());
    if (sha !== transform.metrics_artifact.sha256) return { ok: false, reason: "metrics artifact sha256 mismatch" };
    return { ok: true, skipped: false };
  }
}
