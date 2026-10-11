// POST /v1/ingest/:source (SPEC 7.3, 29.4.1). A source token may post only to its own source. The whole
// batch is validated with zod (max MAX_BATCH_EVENTS events, max 1 MiB body) and accepted all-or-nothing:
// 422 with per-index reasons, or 202 {request_id, accepted} once the LandingRoller holds the request as
// one durable row (one RPC, no Coordinator call per request). 503 landing_backpressure when the landing
// buffer is full; the source retries later.
import { z } from "zod";
import { AtsBatch, HrisBatch, MAX_BODY_BYTES, RawRecord, TalentBatch } from "../../shared/contracts.ts";
import { isSourceId, type SourceId } from "../../shared/sources.ts";
import type { App } from "../app.ts";
import { landingRollerStub } from "../lake/landing-roller.ts";
import { PRODUCER } from "../version.ts";
import { normalizeBatch, toNdjson } from "./normalize.ts";
import "./prewarm.ts";

const BATCHES = { hris: [HrisBatch, "events"], ats: [AtsBatch, "records"], talent: [TalentBatch, "items"] } as const;

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

export function mountIngest(app: App): void {
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
    const records = normalizeBatch(source, items, { receivedAt, requestId, producer: PRODUCER });
    // The lake never receives a row the Iceberg schema would reject: validate every record first.
    for (const record of records) RawRecord.parse(record);
    const landed = await landingRollerStub(c.env).append(toNdjson(records), records.length, Date.parse(receivedAt));
    if (!landed.accepted) {
      c.header("retry-after", "60");
      return c.json({ error: landed.reason, accepted: 0 }, 503);
    }
    return c.json({ request_id: requestId, accepted: records.length }, 202);
  });
}
