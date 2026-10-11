// SinkRoller: the LOCAL STAND-IN for the Basin Pipelines sink (ADR 0003). Miniflare's Pipeline binding
// discards data, so locally accepted records are buffered here and rolled into NDJSON files in the
// local R2 bucket every SINK_ROLL_SECONDS (60 s, the Basin minimum roll interval) or once
// LOCAL_SINK_MAX_RECORDS are buffered. Each roll enqueues an R2-notification-shaped lake event. The
// Python committer turns the files into Iceberg snapshots (pipeline/src/peoplelake/lake/committer.py).
import { DurableObject } from "cloudflare:workers";
import type { RawRecord } from "../../shared/contracts.ts";
import { parseConfig } from "../config.ts";

export const SINK_PREFIX = "local-sink/raw_events/";
export const LOCAL_LAKE_BUCKET = "peoplelake-lake-local";

export interface LakeEventMessage {
  account: string;
  action: "PutObject";
  bucket: string;
  object: { key: string; size: number; eTag: string };
  eventTime: string;
}

export function lakeEventMessage(key: string, size: number, eTag: string, eventTime: Date): LakeEventMessage {
  return { account: "local", action: "PutObject", bucket: LOCAL_LAKE_BUCKET, object: { key, size, eTag }, eventTime: eventTime.toISOString() };
}

export function rollKey(rollSeq: number): string {
  return `${SINK_PREFIX}${String(rollSeq).padStart(8, "0")}.ndjson`;
}

export interface RollResult {
  key: string;
  etag: string;
  size: number;
  records: number;
}

export class SinkRoller extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS buffer (seq INTEGER PRIMARY KEY AUTOINCREMENT, record_json TEXT NOT NULL)`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  #settings(): { rollSeconds: number; maxRecords: number } {
    const cfg = parseConfig(this.env as unknown as Record<string, unknown>, null);
    return { rollSeconds: cfg.sink.rollSeconds, maxRecords: cfg.sink.maxRecords };
  }

  #rollSeq(): number {
    const row = this.#sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = 'roll_seq'`).toArray()[0];
    return row ? Number(row.value) : 1;
  }

  buffered(): number {
    return this.#sql.exec<{ n: number }>(`SELECT count(*) AS n FROM buffer`).one().n;
  }

  async append(records: RawRecord[]): Promise<{ buffered: number; rolled: boolean }> {
    for (const r of records) this.#sql.exec(`INSERT INTO buffer (record_json) VALUES (?)`, JSON.stringify(r));
    const { rollSeconds, maxRecords } = this.#settings();
    if (this.buffered() >= maxRecords) {
      await this.roll();
      return { buffered: this.buffered(), rolled: true };
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + rollSeconds * 1000);
    }
    return { buffered: this.buffered(), rolled: false };
  }

  /** Write the buffer as one roll file. `crashAfterPut` simulates a crash between the put and the delete. */
  async roll(options: { crashAfterPut?: boolean } = {}): Promise<RollResult | null> {
    const rows = this.#sql.exec<{ seq: number; record_json: string }>(`SELECT seq, record_json FROM buffer ORDER BY seq`).toArray();
    if (rows.length === 0) return null;
    const bucket = this.env.LAKE_BUCKET;
    const queue = this.env.LAKE_EVENTS;
    if (!bucket || !queue) throw new Error("SinkRoller is the local stand-in and needs LAKE_BUCKET and LAKE_EVENTS");
    const rollSeq = this.#rollSeq();
    const key = rollKey(rollSeq);
    const maxSeq = rows[rows.length - 1]?.seq ?? 0;
    const body = `${rows.map((r) => r.record_json).join("\n")}\n`;
    const obj = await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
    if (options.crashAfterPut) throw new Error("simulated crash after put");
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(`DELETE FROM buffer WHERE seq <= ?`, maxSeq);
      this.#sql.exec(
        `INSERT INTO state (key, value) VALUES ('roll_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(rollSeq + 1),
      );
    });
    await queue.send(lakeEventMessage(key, obj.size, obj.etag, new Date()));
    console.log(`peoplelake local stand-in: SinkRoller rolled ${rows.length} records to ${key}`);
    return { key, etag: obj.etag, size: obj.size, records: rows.length };
  }

  override async alarm(): Promise<void> {
    await this.roll();
  }

  async flush(): Promise<RollResult | null> {
    await this.ctx.storage.deleteAlarm();
    return this.roll();
  }
}
