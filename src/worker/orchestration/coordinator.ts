// Coordinator Durable Object (singleton "global", SQLite): the run ledger, the job queue with leases,
// single-flight run requests, watermarks and eval faults (SPEC 8.1). Every method that can be retried
// is idempotent: enqueueJob on (run, kind, attempt), completeJob on terminal jobs, commitRun on
// committed runs.
import { DurableObject } from "cloudflare:workers";
import type { FaultSpec, JobKind, JobSpec, RunMode } from "../../shared/contracts.ts";
import { type AppConfig, parseConfig } from "../config.ts";
import { COORDINATOR_DDL, type JobRow, type RunRow } from "./coordinator-sql.ts";

export const COORDINATOR_NAME = "global";
const DISPATCH_QUIET_MS = 90_000;

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
  digests: Record<string, string> | null;
  checks: { error: Record<string, number>; warn: Record<string, number> } | null;
  metrics_key: string | null;
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

export function runIdFor(generation: number, seq: number): string {
  return `r-${generation.toString(36)}-${String(seq).padStart(6, "0")}`;
}

export function coordinatorStub(env: Env): DurableObjectStub<Coordinator> {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_NAME));
}

export class Coordinator extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    for (const ddl of COORDINATOR_DDL) this.#sql.exec(ddl);
    if (this.#get("generation") === null) this.#set("generation", String(Math.floor(Date.now() / 1000)));
  }

  // -- small helpers ------------------------------------------------------------------------------

  #config(): AppConfig {
    return parseConfig(this.env as unknown as Record<string, unknown>, null);
  }

  #get(key: string): string | null {
    const row = this.#sql.exec<{ value: string | null }>("SELECT value FROM state WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  #set(key: string, value: string | null): void {
    if (value === null) {
      this.#sql.exec("DELETE FROM state WHERE key = ?", key);
      return;
    }
    this.#sql.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  #incr(key: string, by = 1): void {
    this.#set(key, String(Number(this.#get(key) ?? "0") + by));
  }

  #run(runId: string): RunRow | null {
    return this.#sql.exec<RunRow>("SELECT * FROM runs WHERE run_id = ?", runId).toArray()[0] ?? null;
  }

  #job(jobId: string): JobRow | null {
    return this.#sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).toArray()[0] ?? null;
  }

  #watermark(name: string): string | null {
    return this.#sql.exec<{ value: string | null }>("SELECT value FROM watermarks WHERE name = ?", name).toArray()[0]?.value ?? null;
  }

  #setWatermark(name: string, value: string, runId: string, now: number): void {
    this.#sql.exec(
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

  #nextDeadline(cfg: AppConfig): number | null {
    const claimMs = cfg.jobs.claimTimeoutSeconds * 1000;
    const runMs = cfg.jobs.runTimeoutMinutes * 60_000;
    const row = this.#sql
      .exec<{ next: number | null }>(
        `SELECT min(deadline) AS next FROM (
           SELECT created_at + ? AS deadline FROM jobs WHERE status = 'queued'
           UNION ALL SELECT lease_until FROM jobs WHERE status = 'claimed'
           UNION ALL SELECT started_at + ? FROM runs WHERE status = 'active')`,
        claimMs,
        runMs,
      )
      .one();
    return row.next;
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
    const active = this.#get("active_run_id");
    if (active !== null) {
      const pending = this.#get("pending_mode");
      this.#set("pending_mode", pending === "replay" || mode === "replay" ? "replay" : "incremental");
      return { run_id: active, started: false, reason: "single_flight" };
    }
    const generation = this.generation();
    const seq = Number(this.#get("run_seq") ?? "0") + 1;
    const runId = runIdFor(generation, seq);
    this.ctx.storage.transactionSync(() => {
      this.#set("run_seq", String(seq));
      this.#set("active_run_id", runId);
      this.#sql.exec(
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
      const committed = this.#sql
        .exec<{ to_snapshot: string | null }>(
          "SELECT to_snapshot FROM runs WHERE status = 'committed' AND to_snapshot IS NOT NULL AND options_json IS NULL ORDER BY seq DESC",
        )
        .toArray();
      from = committed[rewind.snapshots ?? 1]?.to_snapshot ?? null;
    }
    const transformed = this.#watermark("transformed_through_seq");
    const previous = this.#sql
      .exec<{ digests_json: string | null; metrics_key: string | null; to_snapshot: string | null }>(
        "SELECT digests_json, metrics_key, to_snapshot FROM runs WHERE status = 'committed' AND digests_json IS NOT NULL AND options_json IS NULL ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    this.#sql.exec("UPDATE runs SET from_snapshot = ? WHERE run_id = ?", from, runId);
    return {
      run_id: run.run_id,
      seq: run.seq,
      load_seq: run.load_seq,
      mode: run.mode,
      reason: run.reason,
      from_snapshot: from,
      transformed_through_seq: transformed === null ? null : Number(transformed),
      previous: {
        digests: previous?.digests_json ? (JSON.parse(previous.digests_json) as Record<string, string>) : null,
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
      this.#sql.exec(
        `UPDATE runs SET status = 'committed', finished_at = ?, published_at = ?, from_snapshot = ?, to_snapshot = ?,
           rows_inserted = ?, duplicates_skipped = ?, transform_skipped = ?, digests_json = ?, checks_json = ?, metrics_key = ?
         WHERE run_id = ?`,
        now,
        now,
        c.from_snapshot,
        c.to_snapshot,
        c.rows_inserted,
        c.duplicates_skipped,
        c.transform_skipped ? 1 : 0,
        c.digests ? JSON.stringify(c.digests) : null,
        c.checks ? JSON.stringify(c.checks) : null,
        c.metrics_key,
        runId,
      );
      if (!scratch) {
        this.#sql.exec(
          `UPDATE run_freshness SET published_by = ?, published_at = ?
           WHERE published_by IS NULL AND run_id IN (SELECT run_id FROM runs WHERE seq <= ?)`,
          runId,
          now,
          run.seq,
        );
      }
    });
    return { committed: true, duplicate: false };
  }

  failRun(runId: string, error: string, now: number = Date.now()): { failed: boolean } {
    const run = this.#run(runId);
    if (run === null || run.status !== "active") return { failed: false };
    this.#sql.exec("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ?", now, error.slice(0, 2000), runId);
    return { failed: true };
  }

  async releaseRun(runId: string, now: number = Date.now()): Promise<{ released: boolean; next: RequestRunResult | null }> {
    if (this.#get("active_run_id") !== runId) return { released: false, next: null };
    this.#set("active_run_id", null);
    const pending = this.#get("pending_mode") as RunMode | null;
    if (pending === null) return { released: true, next: null };
    this.#set("pending_mode", null);
    return { released: true, next: await this.requestRun("pending", pending, now) };
  }

  // -- jobs -----------------------------------------------------------------------------------------

  async enqueueJob(runId: string, kind: JobKind, attempt: number, input: JobSpec["input"], now: number = Date.now()): Promise<JobSpec> {
    const existing = this.#sql
      .exec<{ input_json: string }>("SELECT input_json FROM jobs WHERE run_id = ? AND kind = ? AND attempt = ?", runId, kind, attempt)
      .toArray()[0];
    if (existing) return JSON.parse(existing.input_json) as JobSpec;
    const run = this.#run(runId);
    if (run === null) throw new Error(`unknown run ${runId}`);
    const cfg = this.#config();
    const faults = cfg.evalFaultsEnabled
      ? this.#faults().filter(
          (f) => f.run_seq === run.seq && (f.attempt ?? 1) === attempt && faultAppliesTo(f, kind),
        )
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
      this.#sql.exec(
        "INSERT INTO jobs (job_id, run_id, kind, attempt, status, input_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
        spec.job_id,
        runId,
        kind,
        attempt,
        JSON.stringify(spec),
        now,
      );
      this.#sql.exec(`UPDATE runs SET ${kind}_attempts = ? WHERE run_id = ?`, attempt, runId);
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
    this.#sql.exec("UPDATE jobs SET dispatch_ref = ? WHERE job_id = ?", ref, jobId);
  }

  async claimJob(workerId: string, now: number = Date.now()): Promise<JobSpec | null> {
    this.#set("runner_last_seen_at", String(now));
    const row = this.#sql
      .exec<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, job_id ASC LIMIT 1")
      .toArray()[0];
    if (!row) return null;
    const cfg = this.#config();
    const leaseUntil = now + cfg.jobs.leaseSeconds * 1000;
    this.#sql.exec(
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
    this.#sql.exec("UPDATE jobs SET lease_until = ? WHERE job_id = ?", leaseUntil, jobId);
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
      this.#sql.exec(
        "UPDATE jobs SET status = ?, finished_at = ?, result_json = ? WHERE job_id = ?",
        status,
        now,
        JSON.stringify(result),
        jobId,
      );
      if (row.kind === "load" && status === "succeeded") {
        const histogram = (result["received_histogram_10s"] ?? []) as [number, number][];
        for (const [bucket, events] of histogram) {
          this.#sql.exec(
            `INSERT INTO run_freshness (run_id, bucket_start_s, events) VALUES (?, ?, ?)
             ON CONFLICT (run_id, bucket_start_s) DO UPDATE SET events = events + excluded.events`,
            row.run_id,
            bucket,
            events,
          );
        }
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
    this.#sql.exec(
      "UPDATE jobs SET status = 'expired', finished_at = ?, result_json = ? WHERE job_id = ?",
      now,
      JSON.stringify(result),
      row.job_id,
    );
    this.#incr("lease_expirations");
    return result;
  }

  /** Expire overdue jobs (sending `expired` events) and fail runs past RUN_TIMEOUT_MINUTES. */
  async sweep(now: number = Date.now()): Promise<{ expired: number; timed_out: number }> {
    const cfg = this.#config();
    const overdue = this.#sql
      .exec<JobRow>(
        `SELECT * FROM jobs WHERE (status = 'queued' AND created_at + ? <= ?) OR (status = 'claimed' AND lease_until <= ?)
         ORDER BY created_at ASC, job_id ASC`,
        cfg.jobs.claimTimeoutSeconds * 1000,
        now,
        now,
      )
      .toArray();
    for (const row of overdue) {
      const result = this.#expire(row, row.status === "queued" ? "claim timeout" : "lease expired", now);
      await this.#sendEvent(row.run_id, `${row.kind}-result-a${row.attempt}`, result);
    }
    const stale = this.#sql
      .exec<{ run_id: string }>(
        "SELECT run_id FROM runs WHERE status = 'active' AND started_at + ? <= ?",
        cfg.jobs.runTimeoutMinutes * 60_000,
        now,
      )
      .toArray();
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
    const next = this.#nextDeadline(cfg);
    if (next !== null) await this.#armAlarm(Math.max(next, now + 1000));
    return { expired: overdue.length, timed_out: stale.length };
  }

  override async alarm(): Promise<void> {
    await this.sweep(Date.now());
  }

  // -- triggers and signals -------------------------------------------------------------------------

  noteIngest(records: number, receivedAt: string): void {
    const ts = Date.parse(receivedAt);
    const prev = Number(this.#get("last_ingest_at") ?? "0");
    if (ts > prev) this.#set("last_ingest_at", String(ts));
    this.#sql.exec(
      `INSERT INTO ingest_minutes (minute, requests, records) VALUES (?, 1, ?)
       ON CONFLICT (minute) DO UPDATE SET requests = requests + 1, records = records + excluded.records`,
      Math.floor(ts / 60_000),
      records,
    );
  }

  markNewData(eventTime: string): void {
    this.#set("last_lake_event_at", eventTime);
  }

  countMalformedLakeEvents(n: number): void {
    this.#incr("malformed_lake_events", n);
  }

  recordCatalogPoll(poll: Record<string, unknown>): void {
    this.#set("catalog_last_poll_json", JSON.stringify(poll));
  }

  /** Cron logic (SPEC 7.6) minus the catalog poll, which the scheduled handler runs and records. */
  async tick(now: number = Date.now()): Promise<{ swept: { expired: number; timed_out: number }; requested: string[] }> {
    const cfg = this.#config();
    const swept = await this.sweep(now);
    const requested: string[] = [];
    if (!cfg.runsEnabled) return { swept, requested };
    const lastIngest = Number(this.#get("last_ingest_at") ?? "0");
    const lastStarted = this.#sql.exec<{ s: number | null }>("SELECT max(started_at) AS s FROM runs").one().s;
    if (cfg.lakeMode === "local" && lastIngest > 0 && (lastStarted === null || lastIngest > lastStarted - (cfg.sink.rollSeconds + 30) * 1000)) {
      await this.requestRun("cron", "incremental", now);
      requested.push("cron");
    }
    if (cfg.heartbeatMinutes > 0 && (lastStarted === null || now - lastStarted >= cfg.heartbeatMinutes * 60_000)) {
      await this.requestRun("heartbeat", "incremental", now);
      requested.push("heartbeat");
    }
    return { swept, requested };
  }

  // -- reads ----------------------------------------------------------------------------------------

  listRuns(limit = 50): RunRow[] {
    return this.#sql.exec<RunRow>("SELECT * FROM runs ORDER BY seq DESC LIMIT ?", Math.max(1, Math.min(limit, 1000))).toArray();
  }

  getRun(runId: string): { run: RunRow; jobs: JobRow[] } | null {
    const run = this.#run(runId);
    if (run === null) return null;
    const jobs = this.#sql.exec<JobRow>("SELECT * FROM jobs WHERE run_id = ? ORDER BY kind DESC, attempt ASC", runId).toArray();
    return { run, jobs };
  }

  freshnessRows(sinceMs: number): { run_id: string; bucket_start_s: number; events: number; published_by: string | null; published_at: number | null }[] {
    return this.#sql
      .exec<{ run_id: string; bucket_start_s: number; events: number; published_by: string | null; published_at: number | null }>(
        "SELECT run_id, bucket_start_s, events, published_by, published_at FROM run_freshness WHERE bucket_start_s * 1000 >= ? ORDER BY bucket_start_s ASC",
        sinceMs,
      )
      .toArray();
  }

  status(): Record<string, unknown> {
    const keys = [
      "generation",
      "run_seq",
      "active_run_id",
      "pending_mode",
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
    ];
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = this.#get(k);
    out["watermark"] = this.#watermark("raw_events");
    out["transformed_through_seq"] = this.#watermark("transformed_through_seq");
    const poll = this.#get("catalog_last_poll_json");
    out["catalog_last_poll"] = poll ? JSON.parse(poll) : null;
    return out;
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
    for (const row of this.#sql.exec<{ key: string }>("SELECT key FROM state WHERE key LIKE 'fault_consumed:%'").toArray()) {
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

  /** Guarded full reset of the ledger (runbook prod-reset.md). A new generation keeps run ids unique. */
  async resetAll(confirm: string, now: number = Date.now()): Promise<{ reset: boolean; generation: number }> {
    if (confirm !== "peoplelake") throw new Error("reset needs confirm=peoplelake");
    if (this.#get("active_run_id") !== null) throw new Error("a run is active; wait for it or disable runs first");
    const previous = this.generation();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const ddl of COORDINATOR_DDL) this.#sql.exec(ddl);
    const generation = Math.max(Math.floor(now / 1000), previous + 1);
    this.#set("generation", String(generation));
    return { reset: true, generation };
  }

  setTestOptions(options: { startWorkflows: boolean }): void {
    if (this.#config().environment !== "local") throw new Error("test options exist only locally");
    this.#set("test_start_workflows", options.startWorkflows ? null : "0");
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
