// POST /v1/ingest/:source (SPEC 7.3). A source token may post only to its own source. The whole batch is
// validated with zod (max 500 events, max 1 MiB body) and accepted all-or-nothing: 422 with per-index
// reasons, or 202 {request_id, accepted} after the lake sink has accepted every record.
import { z } from "zod";
import { AtsBatch, HrisBatch, MAX_BODY_BYTES, RawRecord, TalentBatch } from "../../shared/contracts.ts";
import { isSourceId, type SourceId } from "../../shared/sources.ts";
import type { App } from "../app.ts";
import { selectSink } from "../lake/sink.ts";
import { PRODUCER } from "../version.ts";
import { normalizeBatch } from "./normalize.ts";

const BATCHES = { hris: [HrisBatch, "events"], ats: [AtsBatch, "records"], talent: [TalentBatch, "items"] } as const;

export interface IngestHooks {
  afterAccept?: (env: Env, accepted: number, receivedAt: string) => Promise<void>;
}

export interface Rejection {
  index: number | null;
  reasons: string[];
}

export function rejections(issues: readonly z.core.$ZodIssue[]): Rejection[] {
  const byIndex = new Map<number | null, string[]>();
  for (const issue of issues) {
    const index = typeof issue.path[1] === "number" ? issue.path[1] : null;
    const where = issue.path.slice(index === null ? 1 : 2).join(".");
    const reasons = byIndex.get(index) ?? [];
    reasons.push(where ? `${where}: ${issue.message}` : issue.message);
    byIndex.set(index, reasons);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => (a ?? -1) - (b ?? -1))
    .map(([index, reasons]) => ({ index, reasons }));
}

export function mountIngest(app: App, hooks: IngestHooks = {}): void {
  app.post("/v1/ingest/:source", async (c) => {
    const source = c.req.param("source");
    if (!isSourceId(source)) return c.json({ error: "unknown_source" }, 404);
    const principal = c.get("principal");
    if (!principal.roles.includes(`source:${source}` as const)) return c.json({ error: "forbidden" }, 403);

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return c.json({ error: "payload_too_large", max_bytes: MAX_BODY_BYTES }, 413);
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return c.json({ error: "payload_too_large", max_bytes: MAX_BODY_BYTES }, 413);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const [schema, key] = BATCHES[source as SourceId];
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_batch", accepted: 0, rejected: rejections(parsed.error.issues) }, 422);
    }
    const items = (parsed.data as Record<string, unknown>)[key] as Parameters<typeof normalizeBatch>[1];
    const receivedAt = new Date().toISOString();
    const requestId = crypto.randomUUID();
    const records = await normalizeBatch(source, items, { receivedAt, requestId, producer: PRODUCER });
    // A structured Basin stream accepts invalid records and drops them later, so validate before send.
    for (const record of records) RawRecord.parse(record);
    await selectSink(c.get("config"), c.env).send(records);
    if (hooks.afterAccept) await hooks.afterAccept(c.env, records.length, receivedAt);
    return c.json({ request_id: requestId, accepted: records.length }, 202);
  });
}
