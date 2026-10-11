// LandingRoller (SPEC 29.4.1, ADR 0009): the landing for accepted records, the same code locally and in
// production. One ingest request appends its records as ONE SQLite row (NDJSON text) through one RPC.
// Every LANDING_ROLL_SECONDS (or at once when LANDING_ROLL_MAX_BYTES are buffered) the roller writes a
// planned, immutable roll file to R2 under landing/raw_events/g<generation>/r<roll_seq>.ndjson:
//   (a) plan {roll_seq, max_seq, generation, key} in one row of `state`;
//   (b) put the rows seq <= max_seq in seq order (the same bytes on every retry, so the same etag);
//   (c) in one transaction delete those rows, advance roll_seq and mark the plan "notify";
//   (d) Coordinator.noteRoll and one lake-event Queue message, then drop the plan.
// A crash after (b) repeats (b) to (d) with the same plan, so a key never holds two contents, and roll
// n+1 is planned only after roll n is fully noted, so keys appear in R2 and in the ledger in order. The
// runner commits the rolls to the Iceberg table (pipeline/src/peoplelake/lake/committer.py).
import { DurableObject } from "cloudflare:workers";
import { parseConfig } from "../config.ts";
import { USAGE_FLUSH_MS } from "../../shared/free-budget.ts";
import { MeteredSql, type SqlUsage } from "../lib/metered-sql.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { rollKey } from "./landing-keys.ts";

export { LANDING_PREFIX, landingPrefix, rollKey } from "./landing-keys.ts";
export const LANDING_ROLLER_NAME = "landing";
export const LAKE_BUCKET_NAMES = { local: "peoplelake-lake-local", production: "peoplelake-lake" } as const;

const FAILURE_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;
const MAX_FLUSH_ROLLS = 20;

/** The queue message for one roll; it mirrors the fields of an R2 event notification. */
export interface LakeEventMessage {
  account: string;
  action: "PutObject";
  bucket: string;
  object: { key: string; size: number; eTag: string };
  eventTime: string;
}

export function lakeEventMessage(bucket: string, key: string, size: number, eTag: string, eventTime: Date): LakeEventMessage {
  return { account: "peoplelake", action: "PutObject", bucket, object: { key, size, eTag }, eventTime: eventTime.toISOString() };
}

/** What the Coordinator records per roll (noteRoll). */
export interface LandingRoll {
  key: string;
  etag: string;
  size: number;
  records: number;
  requests: number;
  first_received_at: string;
  last_received_at: string;
}

interface RollPlan {
  phase: "put" | "notify";
  roll_seq: number;
  max_seq: number;
  generation: number;
  key: string;
  records: number;
  requests: number;
  first_received_at: string;
  last_received_at: string;
  etag?: string;
  size?: number;
}

export type AppendResult =
  | { accepted: true; buffered_bytes: number; rolled: boolean }
  | { accepted: false; reason: "landing_backpressure"; buffered_bytes: number };

interface LandingSettings {
  rollSeconds: number;
  rollMaxBytes: number;
  maxBufferBytes: number;
  bucketName: string;
}

const encoder = new TextEncoder();

export function landingRollerStub(env: Env): DurableObjectStub<LandingRoller> {
  return env.LANDING_ROLLER.get(env.LANDING_ROLLER.idFromName(LANDING_ROLLER_NAME));
}

export class LandingRoller extends DurableObject<Env> {
  readonly #db: MeteredSql;
  #bufferedBytes: number;
  #settings: LandingSettings | null = null;
  #testLimits: Partial<Pick<LandingSettings, "rollMaxBytes" | "maxBufferBytes">> = {};
  /** undefined until read from storage once; then the in-memory copy of the armed alarm time. */
  #alarmAt: number | null | undefined = undefined;
  #rolling: Promise<LandingRoll | null> | null = null;
  #failures = 0;
  /** Since this object started (in memory, so counting costs no row writes). */
  #rollsDone = 0;
  #lakeEventsSent = 0;
  #lastUsageFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = new MeteredSql(ctx.storage.sql);
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS buffer (seq INTEGER PRIMARY KEY, received_at_ms INTEGER NOT NULL, records INTEGER NOT NULL, ndjson TEXT NOT NULL)`,
    );
    this.#db.run(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.#bufferedBytes = this.#db.first<{ b: number }>(`SELECT coalesce(sum(length(CAST(ndjson AS BLOB))), 0) AS b FROM buffer`)?.b ?? 0;
    const saved = this.#state("sql_usage");
    this.#db.restore(saved ? (JSON.parse(saved) as SqlUsage) : null);
  }

  /** Persist today's SQL counters at most every 5 minutes (one row write). */
  #flushUsage(now: number): void {
    if (now - this.#lastUsageFlush < USAGE_FLUSH_MS) return;
    this.#lastUsageFlush = now;
    this.#setState("sql_usage", JSON.stringify(this.#db.usage()));
  }

  // -- settings and small helpers ---------------------------------------------------------------------

  #config(): LandingSettings {
    if (this.#settings === null) {
      const cfg = parseConfig(this.env as unknown as Record<string, unknown>, null);
      this.#settings = {
        rollSeconds: cfg.landing.rollSeconds,
        rollMaxBytes: cfg.landing.rollMaxBytes,
        maxBufferBytes: cfg.landing.maxBufferBytes,
        bucketName: LAKE_BUCKET_NAMES[cfg.environment],
      };
    }
    return { ...this.#settings, ...this.#testLimits };
  }

  #state(key: string): string | null {
    return this.#db.first<{ value: string }>(`SELECT value FROM state WHERE key = ?`, key)?.value ?? null;
  }

  #setState(key: string, value: string): void {
    this.#db.run(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  #plan(): RollPlan | null {
    const raw = this.#state("pending_roll");
    return raw ? (JSON.parse(raw) as RollPlan) : null;
  }

  async #armAlarm(at: number): Promise<void> {
    if (this.#alarmAt === undefined) this.#alarmAt = await this.ctx.storage.getAlarm();
    if (this.#alarmAt !== null && this.#alarmAt <= at) return;
    await this.ctx.storage.setAlarm(at);
    this.#alarmAt = at;
  }

  // -- RPC ------------------------------------------------------------------------------------------

  /** One ingest request: its records as NDJSON (one line each, newline terminated), one row. */
  async append(ndjson: string, records: number, receivedAtMs: number): Promise<AppendResult> {
    const settings = this.#config();
    const bytes = encoder.encode(ndjson).byteLength;
    if (this.#bufferedBytes + bytes > settings.maxBufferBytes) {
      return { accepted: false, reason: "landing_backpressure", buffered_bytes: this.#bufferedBytes };
    }
    this.#db.run(`INSERT INTO buffer (received_at_ms, records, ndjson) VALUES (?, ?, ?)`, receivedAtMs, records, ndjson);
    this.#bufferedBytes += bytes;
    if (this.#bufferedBytes >= settings.rollMaxBytes) {
      try {
        await this.roll();
        return { accepted: true, buffered_bytes: this.#bufferedBytes, rolled: true };
      } catch (err) {
        // The row is durable; the alarm retries the roll.
        console.error(`peoplelake landing: roll at the byte threshold failed: ${err instanceof Error ? err.message : String(err)}`);
        await this.#armAlarm(Date.now() + (FAILURE_BACKOFF_MS[0] ?? 5_000));
        return { accepted: true, buffered_bytes: this.#bufferedBytes, rolled: false };
      }
    }
    await this.#armAlarm(Date.now() + settings.rollSeconds * 1000);
    return { accepted: true, buffered_bytes: this.#bufferedBytes, rolled: false };
  }

  /** Single-flight: the alarm, the byte threshold and flush can never roll twice at once. */
  roll(options: { crashAfterPut?: boolean } = {}): Promise<LandingRoll | null> {
    if (this.#rolling !== null) return this.#rolling;
    const running = this.#roll(options).finally(() => {
      this.#rolling = null;
    });
    this.#rolling = running;
    return running;
  }

  async #roll(options: { crashAfterPut?: boolean }): Promise<LandingRoll | null> {
    const settings = this.#config();
    let plan = this.#plan();
    if (plan === null) {
      const agg = this.#db.first<{ max_seq: number | null; records: number | null; requests: number; first_ms: number | null; last_ms: number | null }>(
        `SELECT max(seq) AS max_seq, sum(records) AS records, count(*) AS requests, min(received_at_ms) AS first_ms, max(received_at_ms) AS last_ms FROM buffer`,
      );
      if (agg === null || agg.max_seq === null) return null;
      const generation = await coordinatorStub(this.env).generation();
      const rollSeq = Number(this.#state("roll_seq") ?? "1");
      plan = {
        phase: "put",
        roll_seq: rollSeq,
        max_seq: agg.max_seq,
        generation,
        key: rollKey(generation, rollSeq),
        records: agg.records ?? 0,
        requests: agg.requests,
        first_received_at: new Date(agg.first_ms ?? 0).toISOString(),
        last_received_at: new Date(agg.last_ms ?? 0).toISOString(),
      };
      this.#setState("pending_roll", JSON.stringify(plan));
    }

    if (plan.phase === "put") {
      const rows = this.#db.all<{ ndjson: string }>(`SELECT ndjson FROM buffer WHERE seq <= ? ORDER BY seq`, plan.max_seq);
      const body = rows.map((r) => r.ndjson).join("");
      const obj = await this.env.LAKE_BUCKET.put(plan.key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
      if (options.crashAfterPut) throw new Error("simulated crash after put");
      const noted: RollPlan = { ...plan, phase: "notify", etag: obj.etag, size: obj.size };
      this.ctx.storage.transactionSync(() => {
        this.#db.run(`DELETE FROM buffer WHERE seq <= ?`, noted.max_seq);
        this.#setState("roll_seq", String(noted.roll_seq + 1));
        this.#setState("pending_roll", JSON.stringify(noted));
      });
      this.#bufferedBytes = Math.max(0, this.#bufferedBytes - obj.size);
      plan = noted;
    }

    const roll: LandingRoll = {
      key: plan.key,
      etag: plan.etag ?? "",
      size: plan.size ?? 0,
      records: plan.records,
      requests: plan.requests,
      first_received_at: plan.first_received_at,
      last_received_at: plan.last_received_at,
    };
    await coordinatorStub(this.env).noteRoll(roll);
    await this.env.LAKE_EVENTS.send(lakeEventMessage(settings.bucketName, roll.key, roll.size, roll.etag, new Date()));
    this.#lakeEventsSent++;
    this.#db.run(`DELETE FROM state WHERE key = 'pending_roll'`);
    this.#rollsDone++;
    console.log(`peoplelake landing: rolled ${roll.records} records from ${roll.requests} requests to ${roll.key}`);
    return roll;
  }

  override async alarm(): Promise<void> {
    this.#alarmAt = null;
    this.#flushUsage(Date.now());
    try {
      await this.roll();
      this.#failures = 0;
    } catch (err) {
      const delay = FAILURE_BACKOFF_MS[Math.min(this.#failures, FAILURE_BACKOFF_MS.length - 1)] ?? 600_000;
      this.#failures++;
      console.error(`peoplelake landing: roll failed (attempt ${this.#failures}), retrying in ${delay / 1000} s: ${err instanceof Error ? err.message : String(err)}`);
      await this.#armAlarm(Date.now() + delay);
      return;
    }
    if (this.#bufferedBytes > 0 || this.#plan() !== null) await this.#armAlarm(Date.now() + this.#config().rollSeconds * 1000);
  }

  /** Roll everything buffered now (eval driver, local only through /internal/dev/landing/flush). */
  async flush(): Promise<{ rolls: LandingRoll[] }> {
    const rolls: LandingRoll[] = [];
    for (let i = 0; i < MAX_FLUSH_ROLLS; i++) {
      const roll = await this.roll();
      if (roll === null) break;
      rolls.push(roll);
      if (this.#bufferedBytes === 0 && this.#plan() === null) break;
    }
    return { rolls };
  }

  /** Buffered requests and bytes, the next roll number, rolls and lake events since start, SQL rows today. */
  status(): {
    buffered_requests: number;
    buffered_bytes: number;
    next_roll_seq: number;
    pending_roll: boolean;
    rolls_since_start: number;
    lake_events_since_start: number;
    sql: SqlUsage;
  } {
    const requests = this.#db.first<{ n: number }>(`SELECT count(*) AS n FROM buffer`)?.n ?? 0;
    return {
      buffered_requests: requests,
      buffered_bytes: this.#bufferedBytes,
      next_roll_seq: Number(this.#state("roll_seq") ?? "1"),
      pending_roll: this.#plan() !== null,
      rolls_since_start: this.#rollsDone,
      lake_events_since_start: this.#lakeEventsSent,
      sql: this.#db.usage(),
    };
  }

  /** SQL rows read and written today by this object (tests pin these against the Free allowances). */
  sqlUsage(): SqlUsage {
    return this.#db.usage();
  }

  /** Local tests only: shrink the byte thresholds so rolls and backpressure can be exercised quickly. */
  setTestLimits(limits: { rollMaxBytes?: number; maxBufferBytes?: number }): void {
    if (parseConfig(this.env as unknown as Record<string, unknown>, null).environment !== "local") {
      throw new Error("test limits exist only locally");
    }
    this.#testLimits = {
      ...(limits.rollMaxBytes !== undefined ? { rollMaxBytes: limits.rollMaxBytes } : {}),
      ...(limits.maxBufferBytes !== undefined ? { maxBufferBytes: limits.maxBufferBytes } : {}),
    };
  }
}
