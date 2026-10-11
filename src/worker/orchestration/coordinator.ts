// Coordinator Durable Object (singleton "global", SQLite): the run ledger, the job queue with leases,
// single-flight run requests, watermarks, the landed roll cursor, eval faults and the Workers Free plan
// guards (SPEC 8.1, 29.4.3). Every method that can be retried is idempotent: enqueueJob on (run, kind,
// attempt), completeJob on terminal jobs, commitRun on committed runs, noteRoll on landed keys.
//
// Free plan guards on automatic runs (a lake event or the cron backstop): a minimum interval between
// automatic run starts (a trigger inside it becomes a pending run the alarm starts later), exponential
// backoff after consecutive failed runs, a daily cap, and, for every run, a monthly BigQuery guard that
// lets a run load but skips its transform when the month's billed bytes plus one transform would pass
// the cap. Operator runs and replays bypass all but the BigQuery guard. Every SQL call goes through
// MeteredSql; queries are indexed so rows read stay flat as the ledger grows.
import { DurableObject } from "cloudflare:workers";
import type { FaultSpec, JobKind, JobSpec, RunMode } from "../../shared/contracts.ts";
import { BQ_TRANSFORM_RESERVE_BYTES, backoffMinutes, USAGE_FLUSH_MS } from "../../shared/free-budget.ts";
import { type AppConfig, parseConfig } from "../config.ts";
import { landingPrefix } from "../lake/landing-keys.ts";
import type { LandingRoll } from "../lake/landing-roller.ts";
import { MeteredSql, type SqlUsage, utcDay } from "../lib/metered-sql.ts";
import { COORDINATOR_ADDED_COLUMNS, COORDINATOR_DDL, type JobRow, type RunRow } from "./coordinator-sql.ts";

export const COORDINATOR_NAME = "global";
const DISPATCH_QUIET_MS = 90_000;

/** Run reasons that are automatic triggers; the Free plan guards apply only to these. */
export const AUTOMATIC_REASONS = ["lake-event", "cron", "pending-auto"] as const;

export function isAutomatic(reason: string): boolean {
  return (AUTOMATIC_REASONS as readonly string[]).includes(reason);
}

export interface RunParams {
  run_id: string;
  mode: RunMode;
  reason: string;
}

/** Replay options: read only up to a snapshot and build into a scratch dataset (S5 point-in-time replay). */
export interface RunOptions {
  to_snapshot?: string;
  dataset_suffix?: string;
}

export interface RunPlan {
  run_id: string;
  seq: number;
  load_seq: number;
  mode: RunMode;
  reason: string;
  from_snapshot: string | null;
  /** Landing rolls of this Coordinator generation; the load job's committer lists only these. */
  landing_prefix: string;
  transformed_through_seq: number | null;
  previous: { digests: Record<string, string> | null; metrics_key: string | null; to_snapshot: string | null };
  options: RunOptions;
  lease_seconds: number;
  claim_timeout_seconds: number;
  max_attempts: number;
  wait_timeout_seconds: number;
}

export interface CommitInput {
  from_snapshot: string | null;
  to_snapshot: string | null;
  transformed_through_seq: number | null;
  rows_inserted: number;
  duplicates_skipped: number;
  transform_skipped: boolean;
  /** Why the transform did not run: nothing new ("no_new_data") or the monthly BigQuery guard ("bq_budget"). */
  transform_skip_reason?: string | null;
  digests: Record<string, string> | null;
  checks: { error: Record<string, number>; warn: Record<string, number> } | null;
  metrics_key: string | null;
  /** The committer's landing cursor at to_snapshot; the cron backstop compares it with landed_through. */
  landing_through?: string | null;
  /** Workflow steps the run used, including the release step after the commit. */
  steps_used?: number;
}

export interface ExpiredResult {
  job_id: string;
  run_id: string;
  attempt: number;
  status: "expired";
  error: string;
}

export type WaitResolution = { state: "done"; result_json: string } | { state: "running"; lease_until: number };

export interface RequestRunResult {
  run_id: string | null;
  started: boolean;
  reason?: string;
}

/** Guard values in effect (production: SPEC 29.6; local: wide). */
export interface Guards {
  runMinIntervalSeconds: number;
  failureBackoffBaseMinutes: number;
  failureBackoffMaxMinutes: number;
  autoRunsMaxPerDay: number;
  bqMonthlyBytesCap: number;
}

export interface TransformBudget {
  ok: boolean;
  month: string;
  bytes_billed: number;
  reserve_bytes: number;
  cap_bytes: number;
}

export interface BudgetReport {
  day: string;
  sql: SqlUsage;
  runs: {
    started_today: number;
    automatic_today: number;
    automatic_max_per_day: number;
    min_interval_seconds: number;
    last_automatic_started_at: number | null;
    pending_automatic: boolean;
    consecutive_failures: number;
    failure_backoff_until: number | null;
    workflow_steps_today: number;
  };
  bigquery: TransformBudget;
  workers_ai: { neurons_today: number; cap: number };
  landing: { landed_through: string | null; committed_through: string | null };
}

type Block = { reason: "daily_cap" | "failure_backoff" } | { reason: "min_interval"; until: number };

export function runIdFor(generation: number, seq: number): string {
  return `r-${generation.toString(36)}-${String(seq).padStart(6, "0")}`;
}

export function coordinatorStub(env: Env): DurableObjectStub<Coordinator> {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_NAME));
}

function utcMonth(ms: number): string {
  return utcDay(ms).slice(0, 7);
}

function utcDayStart(ms: number): number {
  return Date.parse(`${utcDay(ms)}T00:00:00.000Z`);
}

export class Coordinator extends DurableObject<Env> {
  readonly #db: MeteredSql;
  #testGuards: Partial<Guards> = {};
  #lastUsageFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = new MeteredSql(ctx.storage.sql);
    this.#migrate();
    if (this.#get("generation") === null) this.#set("generation", String(Math.floor(Date.now() / 1000)));
    const saved = this.#get("sql_usage");
    this.#db.restore(saved ? (JSON.parse(saved) as SqlUsage) : null);
  }

  #migrate(): void {
    for (const ddl of COORDINATOR_DDL) this.#db.run(ddl);
    // Columns added after a local state may have been created (nothing is deployed; local only).
    for (const [table, column, type] of COORDINATOR_ADDED_COLUMNS) {
      try {
        this.#db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // the column exists already
      }
    }
  }

  // -- small helpers ------------------------------------------------------------------------------

  #config(): AppConfig {
    return parseConfig(this.env as unknown as Record<string, unknown>, null);
  }

  #guards(): Guards {
    return { ...this.#config().guards, ...this.#testGuards };
  }

  #get(key: string): string | null {
    return this.#db.first<{ value: string | null }>("SELECT value FROM state WHERE key = ?", key)?.value ?? null;
  }

  #set(key: string, value: string | null): void {
    if (value === null) {
      this.#db.run("DELETE FROM state WHERE key = ?", key);
      return;
    }
    this.#db.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Writes only when the value changes (rows read are cheap on the Free plan, rows written are not). */
  #setIfChanged(key: string, value: string | null): void {
    if (this.#get(key) !== value) this.#set(key, value);
  }

  #incr(key: string, by = 1): void {
    this.#set(key, String(Number(this.#get(key) ?? "0") + by));
  }

  #run(runId: string): RunRow | null {
    return this.#db.first<RunRow>("SELECT * FROM runs WHERE run_id = ?", runId);
  }

  #job(jobId: string): JobRow | null {
    return this.#db.first<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId);
  }

  #watermark(name: string): string | null {
    return this.#db.first<{ value: string | null }>("SELECT value FROM watermarks WHERE name = ?", name)?.value ?? null;
  }

  #setWatermark(name: string, value: string, runId: string, now: number): void {
    this.#db.run(
      `INSERT INTO watermarks (name, value, run_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET value = excluded.value, run_id = excluded.run_id, updated_at = excluded.updated_at`,
      name,
      value,
      runId,
      now,
    );
  }

  #faults(): FaultSpec[] {
    const raw = this.#get("faults_json");
    return raw ? (JSON.parse(raw) as FaultSpec[]) : [];
  }

  async #armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  /** When the pending automatic run may start (the minimum interval after the last automatic start). */
  #pendingAutoDue(): number | null {
    if (this.#get("pending_auto") === null) return null;
    return Number(this.#get("last_auto_run_started_at") ?? "0") + this.#guards().runMinIntervalSeconds * 1000;
  }

  #nextDeadline(cfg: AppConfig): number | null {
    const queued = this.#db.first<{ t: number }>("SELECT created_at AS t FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1");
    const claimed = this.#db.first<{ t: number | null }>("SELECT min(lease_until) AS t FROM jobs WHERE status = 'claimed'");
    const active = this.#db.first<{ t: number }>("SELECT started_at AS t FROM runs WHERE status = 'active' ORDER BY started_at ASC LIMIT 1");
    const deadlines = [
      queued ? queued.t + cfg.jobs.claimTimeoutSeconds * 1000 : null,
      claimed?.t ?? null,
      active ? active.t + cfg.jobs.runTimeoutMinutes * 60_000 : null,
      this.#pendingAutoDue(),
    ].filter((t): t is number => t !== null);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  async #startWorkflow(runId: string, params: RunParams): Promise<void> {
    if (this.#get("test_start_workflows") === "0") return;
    try {
      await this.env.WAREHOUSE_RUN.create({ id: runId, params });
    } catch (err) {
      // Idempotent: if an instance with this id already exists (a retried request), use it.
      try {
        await this.env.WAREHOUSE_RUN.get(runId);
      } catch {
        throw err;
      }
    }
  }

  async #sendEvent(runId: string, type: string, payload: unknown): Promise<void> {
    if (this.#get("test_start_workflows") === "0") {
      this.#incr("events_sent");
      return;
    }
    try {
      const instance = await this.env.WAREHOUSE_RUN.get(runId);
      await instance.sendEvent({ type, payload });
      this.#incr("events_sent");
    } catch (err) {
      // The instance may already have finished (for example a stale result after a timeout).
      this.#incr("event_errors");
      this.#set("last_event_error", `${type} -> ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #flushUsage(now: number): void {
    if (now - this.#lastUsageFlush < USAGE_FLUSH_MS) return;
    this.#lastUsageFlush = now;
    this.#set("sql_usage", JSON.stringify(this.#db.usage()));
  }

  // -- guards ---------------------------------------------------------------------------------------

  #automaticOn(day: string): number {
    const raw = this.#get("auto_runs_day");
    const parsed = raw ? (JSON.parse(raw) as { day: string; count: number }) : null;
    return parsed?.day === day ? parsed.count : 0;
  }

  #failureBackoffUntil(): number | null {
    const failures = Number(this.#get("consecutive_failures") ?? "0");
    if (failures <= 0) return null;
    const g = this.#guards();
    const minutes = backoffMinutes(failures, g.failureBackoffBaseMinutes, g.failureBackoffMaxMinutes);
    return minutes > 0 ? Number(this.#get("last_failure_at") ?? "0") + minutes * 60_000 : null;
  }

  #automaticBlock(now: number): Block | null {
    const g = this.#guards();
    if (this.#automaticOn(utcDay(now)) >= g.autoRunsMaxPerDay) return { reason: "daily_cap" };
    const backoffUntil = this.#failureBackoffUntil();
    if (backoffUntil !== null && now < backoffUntil) return { reason: "failure_backoff" };
    const lastAuto = Number(this.#get("last_auto_run_started_at") ?? "0");
    const until = lastAuto + g.runMinIntervalSeconds * 1000;
    if (lastAuto > 0 && g.runMinIntervalSeconds > 0 && now < until) return { reason: "min_interval", until };
    return null;
  }

  #bqMonth(now: number): { month: string; bytes: number } {
    const raw = this.#get("bq_bytes_month");
    const parsed = raw ? (JSON.parse(raw) as { month: string; bytes: number }) : null;
    const month = utcMonth(now);
    return parsed?.month === month ? parsed : { month, bytes: 0 };
  }

  #addBqBytes(now: number, bytes: number): void {
    if (!(bytes > 0)) return;
    const m = this.#bqMonth(now);
    this.#set("bq_bytes_month", JSON.stringify({ month: m.month, bytes: m.bytes + bytes }));
  }

  /** The monthly BigQuery guard: a transform may run while billed bytes plus one transform stay under the cap. */
  transformBudget(now: number = Date.now()): TransformBudget {
    const m = this.#bqMonth(now);
    const cap = this.#guards().bqMonthlyBytesCap;
    return { ok: m.bytes + BQ_TRANSFORM_RESERVE_BYTES <= cap, month: m.month, bytes_billed: m.bytes, reserve_bytes: BQ_TRANSFORM_RESERVE_BYTES, cap_bytes: cap };
  }

  // -- Workers AI neuron ledger (SPEC 29.4.5) ---------------------------------------------------------

  #neuronsOn(day: string): number {
    const raw = this.#get("ai_neurons_day");
    const parsed = raw ? (JSON.parse(raw) as { day: string; neurons: number }) : null;
    return parsed?.day === day ? parsed.neurons : 0;
  }

  /** Reserve neurons for one Workers AI call, refusing when the UTC day's total would pass the cap. */
  reserveNeurons(neurons: number, now: number = Date.now()): { ok: boolean; used: number; cap: number } {
    const cap = this.#config().ai.dailyNeuronCap;
    const day = utcDay(now);
    const used = this.#neuronsOn(day);
    if (used + neurons > cap) return { ok: false, used, cap };
    this.#set("ai_neurons_day", JSON.stringify({ day, neurons: used + neurons }));
    return { ok: true, used: used + neurons, cap };
  }

  /** Correct today's reservation once Workers AI reports the tokens a call used. */
  adjustNeurons(delta: number, now: number = Date.now()): { used: number } {
    const day = utcDay(now);
    const used = Math.max(0, this.#neuronsOn(day) + delta);
    this.#set("ai_neurons_day", JSON.stringify({ day, neurons: used }));
    return { used };
  }

  // -- runs -----------------------------------------------------------------------------------------

  generation(): number {
    return Number(this.#get("generation"));
  }

  nextRunId(): string {
    return runIdFor(this.generation(), Number(this.#get("run_seq") ?? "0") + 1);
  }

  async requestRun(
    reason: string,
    mode: RunMode = "incremental",
    now: number = Date.now(),
    options: RunOptions = {},
  ): Promise<RequestRunResult> {
    const cfg = this.#config();
    if (!cfg.runsEnabled) return { run_id: null, started: false, reason: "runs_disabled" };
    const automatic = isAutomatic(reason) && mode === "incremental" && Object.keys(options).length === 0;
    if (automatic) {
      const block = this.#automaticBlock(now);
      if (block !== null) {
        if (block.reason === "min_interval") {
          this.#setIfChanged("pending_auto", "1");
          await this.#armAlarm(block.until);
        }
        return { run_id: this.#get("active_run_id"), started: false, reason: block.reason };
      }
    }
    const active = this.#get("active_run_id");
    if (active !== null) {
      const pending = this.#get("pending_mode");
      this.#setIfChanged("pending_mode", pending === "replay" || mode === "replay" ? "replay" : "incremental");
      // An operator's pending request is never subject to the automatic guards.
      const kind = this.#get("pending_kind");
      this.#setIfChanged("pending_kind", automatic && kind !== "operator" ? "auto" : "operator");
      return { run_id: active, started: false, reason: "single_flight" };
    }
    const generation = this.generation();
    const seq = Number(this.#get("run_seq") ?? "0") + 1;
    const runId = runIdFor(generation, seq);
    this.ctx.storage.transactionSync(() => {
      this.#set("run_seq", String(seq));
      this.#set("active_run_id", runId);
      this.#set("last_run_started_at", String(now));
      if (automatic) {
        const day = utcDay(now);
        this.#set("auto_runs_day", JSON.stringify({ day, count: this.#automaticOn(day) + 1 }));
        this.#set("last_auto_run_started_at", String(now));
        if (this.#get("pending_auto") !== null) this.#set("pending_auto", null);
      }
      this.#db.run(
        `INSERT INTO runs (run_id, seq, load_seq, mode, reason, status, requested_at, started_at, options_json)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        runId,
        seq,
        generation * 1_000_000 + seq,
        mode,
        reason,
        now,
        now,
        Object.keys(options).length > 0 ? JSON.stringify(options) : null,
      );
    });
    try {
      await this.#startWorkflow(runId, { run_id: runId, mode, reason });
    } catch (err) {
      this.failRun(runId, `could not start workflow: ${err instanceof Error ? err.message : String(err)}`, now);
      this.#set("active_run_id", null);
      throw err;
    }
    await this.#armAlarm(now + cfg.jobs.runTimeoutMinutes * 60_000);
    return { run_id: runId, started: true };
  }

  openRun(runId: string): RunPlan {
    const run = this.#run(runId);
    if (run === null) throw new Error(`unknown run ${runId}`);
    const cfg = this.#config();
    const options = run.options_json ? (JSON.parse(run.options_json) as RunOptions) : {};
    let from = run.mode === "replay" ? null : this.#watermark("raw_events");
    const rewind = this.#faults().find((f) => f.kind === "rewind_watermark" && f.run_seq === run.seq);
    if (rewind && cfg.evalFaultsEnabled && run.mode === "incremental") {
      const back = rewind.snapshots ?? 1;
      const committed = this.#db.all<{ to_snapshot: string | null }>(
        "SELECT to_snapshot FROM runs WHERE status = 'committed' AND to_snapshot IS NOT NULL AND options_json IS NULL ORDER BY seq DESC LIMIT ?",
        back + 1,
      );
      from = committed[back]?.to_snapshot ?? null;
    }
    const transformed = this.#watermark("transformed_through_seq");
    const published = this.#get("published_json");
    const previous = published
      ? (JSON.parse(published) as { digests: Record<string, string> | null; metrics_key: string | null; to_snapshot: string | null })
      : null;
    this.#db.run("UPDATE runs SET from_snapshot = ? WHERE run_id = ?", from, runId);
    return {
      run_id: run.run_id,
      seq: run.seq,
      load_seq: run.load_seq,
      mode: run.mode,
      reason: run.reason,
      from_snapshot: from,
      landing_prefix: landingPrefix(this.generation()),
      transformed_through_seq: transformed === null ? null : Number(transformed),
      previous: {
        digests: previous?.digests ?? null,
        metrics_key: previous?.metrics_key ?? null,
        to_snapshot: previous?.to_snapshot ?? null,
      },
      options,
      lease_seconds: cfg.jobs.leaseSeconds,
      claim_timeout_seconds: cfg.jobs.claimTimeoutSeconds,
      max_attempts: cfg.jobs.maxAttempts,
      wait_timeout_seconds: cfg.jobs.leaseSeconds + cfg.jobs.claimTimeoutSeconds + 60,
    };
  }

  commitRun(runId: string, c: CommitInput, now: number = Date.now()): { committed: boolean; duplicate: boolean } {
    const run = this.#run(runId);
    if (run === null) throw new Error(`unknown run ${runId}`);
    if (run.status === "committed") return { committed: true, duplicate: true };
    if (run.status !== "active") return { committed: false, duplicate: false };
    // A scratch replay (dataset_suffix) records its digests but never moves the published state.
    const scratch = run.options_json !== null && (JSON.parse(run.options_json) as RunOptions).dataset_suffix !== undefined;
    this.ctx.storage.transactionSync(() => {
      if (!scratch && c.to_snapshot !== null) this.#setWatermark("raw_events", c.to_snapshot, runId, now);
      if (!scratch && c.transformed_through_seq !== null) {
        this.#setWatermark("transformed_through_seq", String(c.transformed_through_seq), runId, now);
      }
      if (!scratch && c.landing_through) this.#setIfChanged("committed_through", c.landing_through);
      if (!scratch && c.digests !== null) {
        this.#set("published_json", JSON.stringify({ digests: c.digests, metrics_key: c.metrics_key, to_snapshot: c.to_snapshot, run_id: runId }));
      }
      if (this.#get("consecutive_failures") !== null) this.#set("consecutive_failures", null);
      this.#db.run(
        `UPDATE runs SET status = 'committed', finished_at = ?, published_at = ?, from_snapshot = ?, to_snapshot = ?,
           rows_inserted = ?, duplicates_skipped = ?, transform_skipped = ?, transform_skip_reason = ?, digests_json = ?,
           checks_json = ?, metrics_key = ?, landing_through = ?, steps_used = ?
         WHERE run_id = ?`,
        now,
        now,
        c.from_snapshot,
        c.to_snapshot,
        c.rows_inserted,
        c.duplicates_skipped,
        c.transform_skipped ? 1 : 0,
        c.transform_skip_reason ?? null,
        c.digests ? JSON.stringify(c.digests) : null,
        c.checks ? JSON.stringify(c.checks) : null,
        c.metrics_key,
        c.landing_through ?? null,
        c.steps_used ?? null,
        runId,
      );
      if (!scratch) {
        // Single-flight: every unpublished bucket belongs to this run or an earlier one (indexed on published_by).
        this.#db.run("UPDATE run_freshness SET published_by = ?, published_at = ? WHERE published_by IS NULL", runId, now);
      }
    });
    return { committed: true, duplicate: false };
  }

  failRun(runId: string, error: string, now: number = Date.now(), stepsUsed?: number): { failed: boolean } {
    const run = this.#run(runId);
    if (run === null || run.status !== "active") return { failed: false };
    this.ctx.storage.transactionSync(() => {
      this.#db.run(
        "UPDATE runs SET status = 'failed', finished_at = ?, error = ?, steps_used = ? WHERE run_id = ?",
        now,
        error.slice(0, 2000),
        stepsUsed ?? null,
        runId,
      );
      this.#incr("consecutive_failures");
      this.#set("last_failure_at", String(now));
    });
    return { failed: true };
  }

  async releaseRun(runId: string, now: number = Date.now()): Promise<{ released: boolean; next: RequestRunResult | null }> {
    if (this.#get("active_run_id") !== runId) return { released: false, next: null };
    this.#set("active_run_id", null);
    const pending = this.#get("pending_mode") as RunMode | null;
    if (pending === null) return { released: true, next: null };
    const kind = this.#get("pending_kind");
    this.#set("pending_mode", null);
    if (kind !== null) this.#set("pending_kind", null);
    return { released: true, next: await this.requestRun(kind === "auto" ? "pending-auto" : "pending", pending, now) };
  }

  // -- jobs -----------------------------------------------------------------------------------------

  async enqueueJob(runId: string, kind: JobKind, attempt: number, input: JobSpec["input"], now: number = Date.now()): Promise<JobSpec> {
    const existing = this.#db.first<{ input_json: string }>(
      "SELECT input_json FROM jobs WHERE run_id = ? AND kind = ? AND attempt = ?",
      runId,
      kind,
      attempt,
    );
    if (existing) return JSON.parse(existing.input_json) as JobSpec;
    const run = this.#run(runId);
    if (run === null) throw new Error(`unknown run ${runId}`);
    const cfg = this.#config();
    const faults = cfg.evalFaultsEnabled
      ? this.#faults().filter((f) => f.run_seq === run.seq && (f.attempt ?? 1) === attempt && faultAppliesTo(f, kind))
      : [];
    const spec: JobSpec = {
      job_id: `${runId}-${kind}-a${attempt}`,
      run_id: runId,
      load_seq: run.load_seq,
      kind,
      attempt,
      mode: run.mode,
      input,
      lease_seconds: cfg.jobs.leaseSeconds,
      ...(faults.length > 0 ? { faults } : {}),
    };
    this.ctx.storage.transactionSync(() => {
      this.#db.run(
        "INSERT INTO jobs (job_id, run_id, kind, attempt, status, input_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
        spec.job_id,
        runId,
        kind,
        attempt,
        JSON.stringify(spec),
        now,
      );
      this.#db.run(`UPDATE runs SET ${kind}_attempts = ? WHERE run_id = ?`, attempt, runId);
    });
    await this.#armAlarm(now + cfg.jobs.claimTimeoutSeconds * 1000);
    return spec;
  }

  shouldDispatch(now: number = Date.now()): boolean {
    const cfg = this.#config();
    const seen = Number(this.#get("runner_last_seen_at") ?? "0");
    if (seen > 0 && now - seen < cfg.runnerSeenWindowSeconds * 1000) return false;
    const dispatched = Number(this.#get("last_dispatch_at") ?? "0");
    const claimed = Number(this.#get("last_claim_at") ?? "0");
    if (dispatched > 0 && now - dispatched < DISPATCH_QUIET_MS && claimed <= dispatched) return false;
    return true;
  }

  noteDispatch(jobId: string, ref: string | null, now: number = Date.now()): void {
    this.#set("last_dispatch_at", String(now));
    this.#db.run("UPDATE jobs SET dispatch_ref = ? WHERE job_id = ?", ref, jobId);
  }

  async claimJob(workerId: string, now: number = Date.now()): Promise<JobSpec | null> {
    this.#set("runner_last_seen_at", String(now));
    const row = this.#db.first<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, job_id ASC LIMIT 1");
    if (!row) return null;
    const cfg = this.#config();
    const leaseUntil = now + cfg.jobs.leaseSeconds * 1000;
    this.#db.run(
      "UPDATE jobs SET status = 'claimed', claimed_at = ?, claimed_by = ?, lease_until = ? WHERE job_id = ?",
      now,
      workerId,
      leaseUntil,
      row.job_id,
    );
    this.#set("last_claim_at", String(now));
    await this.#armAlarm(leaseUntil);
    return JSON.parse(row.input_json) as JobSpec;
  }

  heartbeat(jobId: string, workerId: string, now: number = Date.now()): { ok: boolean; lease_until: number | null } {
    this.#set("runner_last_seen_at", String(now));
    const row = this.#job(jobId);
    if (row === null || row.status !== "claimed" || row.claimed_by !== workerId) return { ok: false, lease_until: null };
    const leaseUntil = now + this.#config().jobs.leaseSeconds * 1000;
    this.#db.run("UPDATE jobs SET lease_until = ? WHERE job_id = ?", leaseUntil, jobId);
    return { ok: true, lease_until: leaseUntil };
  }

  async completeJob(jobId: string, result: Record<string, unknown>, now: number = Date.now()): Promise<{ duplicate: boolean; known: boolean }> {
    this.#set("runner_last_seen_at", String(now));
    const row = this.#job(jobId);
    if (row === null) return { duplicate: false, known: false };
    if (row.status === "succeeded" || row.status === "failed" || row.status === "expired") {
      this.#incr("duplicate_results");
      return { duplicate: true, known: true };
    }
    const status = result["status"] === "succeeded" ? "succeeded" : "failed";
    this.ctx.storage.transactionSync(() => {
      this.#db.run("UPDATE jobs SET status = ?, finished_at = ?, result_json = ? WHERE job_id = ?", status, now, JSON.stringify(result), jobId);
      if (row.kind === "load" && status === "succeeded") {
        const histogram = (result["received_histogram_10s"] ?? []) as [number, number][];
        for (const [bucket, events] of histogram) {
          this.#db.run(
            `INSERT INTO run_freshness (run_id, bucket_start_s, events) VALUES (?, ?, ?)
             ON CONFLICT (run_id, bucket_start_s) DO UPDATE SET events = events + excluded.events`,
            row.run_id,
            bucket,
            events,
          );
        }
      }
      if (status === "succeeded") {
        const billed = row.kind === "load" ? result["bytes_billed"] : (result["dbt"] as { bytes_billed?: unknown } | undefined)?.bytes_billed;
        if (typeof billed === "number") this.#addBqBytes(now, billed);
      }
    });
    await this.#sendEvent(row.run_id, `${row.kind}-result-a${row.attempt}`, result);
    return { duplicate: false, known: true };
  }

  jobStatus(jobId: string): JobRow | null {
    return this.#job(jobId);
  }

  /** Called by the Workflow when its wait times out: a terminal result, a live lease, or expire now. */
  resolveWait(jobId: string, now: number = Date.now()): WaitResolution {
    const row = this.#job(jobId);
    if (row === null) throw new Error(`unknown job ${jobId}`);
    if (row.status === "succeeded" || row.status === "failed" || row.status === "expired") {
      return { state: "done", result_json: row.result_json ?? "{}" };
    }
    if (row.status === "claimed" && (row.lease_until ?? 0) > now) return { state: "running", lease_until: row.lease_until ?? now };
    const expired = this.#expire(row, "no result before the wait timed out", now);
    return { state: "done", result_json: JSON.stringify(expired) };
  }

  #expire(row: JobRow, why: string, now: number): ExpiredResult {
    const result: ExpiredResult = { job_id: row.job_id, run_id: row.run_id, attempt: row.attempt, status: "expired", error: why };
    this.#db.run("UPDATE jobs SET status = 'expired', finished_at = ?, result_json = ? WHERE job_id = ?", now, JSON.stringify(result), row.job_id);
    this.#incr("lease_expirations");
    return result;
  }

  /** Expire overdue jobs (sending `expired` events), fail runs past RUN_TIMEOUT_MINUTES and start a pending
   * automatic run whose minimum interval has passed. Every query is indexed. */
  async sweep(now: number = Date.now()): Promise<{ expired: number; timed_out: number }> {
    const cfg = this.#config();
    const overdue = [
      ...this.#db.all<JobRow>(
        "SELECT * FROM jobs WHERE status = 'queued' AND created_at <= ? ORDER BY created_at ASC, job_id ASC",
        now - cfg.jobs.claimTimeoutSeconds * 1000,
      ),
      ...this.#db.all<JobRow>("SELECT * FROM jobs WHERE status = 'claimed' AND lease_until <= ?", now),
    ].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.job_id.localeCompare(b.job_id));
    for (const row of overdue) {
      const result = this.#expire(row, row.status === "queued" ? "claim timeout" : "lease expired", now);
      await this.#sendEvent(row.run_id, `${row.kind}-result-a${row.attempt}`, result);
    }
    const stale = this.#db.all<{ run_id: string }>(
      "SELECT run_id FROM runs WHERE status = 'active' AND started_at <= ?",
      now - cfg.jobs.runTimeoutMinutes * 60_000,
    );
    for (const { run_id } of stale) {
      this.failRun(run_id, "run timeout", now);
      if (this.#get("test_start_workflows") !== "0") {
        try {
          await (await this.env.WAREHOUSE_RUN.get(run_id)).terminate();
        } catch {
          // already finished
        }
      }
      await this.releaseRun(run_id, now);
    }
    const due = this.#pendingAutoDue();
    if (due !== null && now >= due && this.#get("active_run_id") === null) {
      this.#set("pending_auto", null);
      if (cfg.runsEnabled) await this.requestRun("pending-auto", "incremental", now);
    }
    const next = this.#nextDeadline(cfg);
    if (next !== null) await this.#armAlarm(Math.max(next, now + 1000));
    return { expired: overdue.length, timed_out: stale.length };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.sweep(now);
    this.#flushUsage(now);
  }

  // -- triggers and signals -------------------------------------------------------------------------

  /** Once per landing roll (LandingRoller step d). Idempotent: rolls arrive in key order, so a key at or
   * below landed_through was already noted. */
  noteRoll(roll: LandingRoll, now: number = Date.now()): { noted: boolean } {
    const through = this.#get("landed_through");
    if (through !== null && roll.key <= through) return { noted: false };
    this.ctx.storage.transactionSync(() => {
      this.#set("landed_through", roll.key);
      this.#incr("landed_rolls");
      this.#incr("landed_records", roll.records);
      this.#set("last_ingest_at", String(Date.parse(roll.last_received_at)));
      this.#set("last_roll_json", JSON.stringify({ ...roll, noted_at: now }));
    });
    return { noted: true };
  }

  markNewData(eventTime: string): void {
    this.#set("last_lake_event_at", eventTime);
  }

  countMalformedLakeEvents(n: number): void {
    this.#incr("malformed_lake_events", n);
  }

  /** Cron every 5 minutes (SPEC 29.4.3): sweeps, the usage flush and the backstop, which requests an
   * automatic run when a landed roll is past the committed cursor and no run is active. */
  async tick(now: number = Date.now()): Promise<{ swept: { expired: number; timed_out: number }; requested: string[]; blocked: string | null }> {
    const cfg = this.#config();
    const swept = await this.sweep(now);
    this.#flushUsage(now);
    const requested: string[] = [];
    let blocked: string | null = null;
    if (!cfg.runsEnabled) return { swept, requested, blocked };
    const landed = this.#get("landed_through");
    const committed = this.#get("committed_through");
    if (landed !== null && (committed === null || landed > committed) && this.#get("active_run_id") === null) {
      const res = await this.requestRun("cron", "incremental", now);
      if (res.started) requested.push("cron");
      else blocked = res.reason ?? null;
    }
    const lastStarted = this.#get("last_run_started_at");
    if (cfg.heartbeatMinutes > 0 && (lastStarted === null || now - Number(lastStarted) >= cfg.heartbeatMinutes * 60_000)) {
      await this.requestRun("heartbeat", "incremental", now);
      requested.push("heartbeat");
    }
    return { swept, requested, blocked };
  }

  // -- reads ----------------------------------------------------------------------------------------

  /** Newest first, or (with `since`, epoch ms) runs started at or after it, oldest first. At most 200. */
  listRuns(limit = 50, since: number | null = null): RunRow[] {
    const n = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
    if (since !== null) {
      return this.#db.all<RunRow>("SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at ASC, seq ASC LIMIT ?", since, n);
    }
    return this.#db.all<RunRow>("SELECT * FROM runs ORDER BY seq DESC LIMIT ?", n);
  }

  getRun(runId: string): { run: RunRow; jobs: JobRow[] } | null {
    const run = this.#run(runId);
    if (run === null) return null;
    const jobs = this.#db.all<JobRow>("SELECT * FROM jobs WHERE run_id = ? ORDER BY kind DESC, attempt ASC", runId);
    return { run, jobs };
  }

  freshnessRows(sinceMs: number): { run_id: string; bucket_start_s: number; events: number; published_by: string | null; published_at: number | null }[] {
    return this.#db.all<{ run_id: string; bucket_start_s: number; events: number; published_by: string | null; published_at: number | null }>(
      "SELECT run_id, bucket_start_s, events, published_by, published_at FROM run_freshness WHERE bucket_start_s >= ? ORDER BY bucket_start_s ASC",
      Math.ceil(sinceMs / 1000),
    );
  }

  status(): Record<string, unknown> {
    const keys = [
      "generation",
      "run_seq",
      "active_run_id",
      "pending_mode",
      "pending_kind",
      "pending_auto",
      "last_ingest_at",
      "last_lake_event_at",
      "runner_last_seen_at",
      "last_dispatch_at",
      "last_claim_at",
      "events_sent",
      "event_errors",
      "last_event_error",
      "duplicate_results",
      "lease_expirations",
      "malformed_lake_events",
      "faults_fired",
      "landed_through",
      "landed_rolls",
      "landed_records",
      "committed_through",
      "consecutive_failures",
    ];
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = this.#get(k);
    out["watermark"] = this.#watermark("raw_events");
    out["transformed_through_seq"] = this.#watermark("transformed_through_seq");
    const roll = this.#get("last_roll_json");
    out["last_roll"] = roll ? JSON.parse(roll) : null;
    return out;
  }

  /** Free plan budget state for GET /api/ops/budget (operator). */
  budget(now: number = Date.now()): BudgetReport {
    const g = this.#guards();
    const dayStart = utcDayStart(now);
    const today = this.#db.first<{ runs: number; steps: number | null }>(
      "SELECT count(*) AS runs, sum(steps_used) AS steps FROM runs WHERE started_at >= ?",
      dayStart,
    );
    const lastAuto = this.#get("last_auto_run_started_at");
    return {
      day: utcDay(now),
      sql: this.#db.usage(),
      runs: {
        started_today: today?.runs ?? 0,
        automatic_today: this.#automaticOn(utcDay(now)),
        automatic_max_per_day: g.autoRunsMaxPerDay,
        min_interval_seconds: g.runMinIntervalSeconds,
        last_automatic_started_at: lastAuto === null ? null : Number(lastAuto),
        pending_automatic: this.#get("pending_auto") !== null,
        consecutive_failures: Number(this.#get("consecutive_failures") ?? "0"),
        failure_backoff_until: this.#failureBackoffUntil(),
        workflow_steps_today: today?.steps ?? 0,
      },
      bigquery: this.transformBudget(now),
      workers_ai: { neurons_today: this.#neuronsOn(utcDay(now)), cap: this.#config().ai.dailyNeuronCap },
      landing: { landed_through: this.#get("landed_through"), committed_through: this.#get("committed_through") },
    };
  }

  /** SQL rows read and written today by this object. */
  sqlUsage(): SqlUsage {
    return this.#db.usage();
  }

  // -- tokens, faults, test hooks ---------------------------------------------------------------------

  getGcpToken(): { token: string; expires_at: number } | null {
    const raw = this.#get("gcp_token_json");
    return raw ? (JSON.parse(raw) as { token: string; expires_at: number }) : null;
  }

  setGcpToken(token: { token: string; expires_at: number }): void {
    this.#set("gcp_token_json", JSON.stringify(token));
  }

  installFaults(faults: FaultSpec[]): { installed: number } {
    if (!this.#config().evalFaultsEnabled) throw new Error("faults are disabled (EVAL_FAULTS_ENABLED=false)");
    this.#set("faults_json", JSON.stringify(faults));
    for (const row of this.#db.all<{ key: string }>("SELECT key FROM state WHERE key LIKE 'fault_consumed:%'")) {
      this.#set(row.key, null);
    }
    return { installed: faults.length };
  }

  /** commit_step_error: true exactly once for the faulted run, so the commit step throws and retries. */
  consumeCommitFault(runId: string): boolean {
    if (!this.#config().evalFaultsEnabled) return false;
    const run = this.#run(runId);
    if (run === null) return false;
    const fault = this.#faults().find((f) => f.kind === "commit_step_error" && f.run_seq === run.seq);
    if (!fault) return false;
    const key = `fault_consumed:${run.seq}:commit_step_error`;
    if (this.#get(key) !== null) return false;
    this.#set(key, String(Date.now()));
    this.#incr("faults_fired");
    return true;
  }

  /** Guarded full reset of the ledger (runbook prod-reset.md). A new generation keeps run ids unique and
   * makes the committer list only the new generation's landing rolls. */
  async resetAll(confirm: string, now: number = Date.now()): Promise<{ reset: boolean; generation: number }> {
    if (confirm !== "peoplelake") throw new Error("reset needs confirm=peoplelake");
    if (this.#get("active_run_id") !== null) throw new Error("a run is active; wait for it or disable runs first");
    const previous = this.generation();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#migrate();
    const generation = Math.max(Math.floor(now / 1000), previous + 1);
    this.#set("generation", String(generation));
    return { reset: true, generation };
  }

  setTestOptions(options: { startWorkflows?: boolean; guards?: Partial<Guards> }): void {
    if (this.#config().environment !== "local") throw new Error("test options exist only locally");
    if (options.startWorkflows !== undefined) this.#set("test_start_workflows", options.startWorkflows ? null : "0");
    if (options.guards !== undefined) this.#testGuards = { ...options.guards };
  }
}

function faultAppliesTo(fault: FaultSpec, kind: JobKind): boolean {
  switch (fault.kind) {
    case "crash_after_load":
    case "recommit_sink_files":
      return kind === "load";
    case "fail_transform_model":
      return kind === "transform";
    case "duplicate_result":
    case "skip_claim":
      return kind === (fault.job ?? "load");
    default:
      return false;
  }
}
