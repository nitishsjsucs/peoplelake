import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import canonicalGolden from "../../contracts/golden/canonical-json.json";
import rawGolden from "../../contracts/golden/raw-records.json";
import ats from "../../contracts/fixtures/source-ats.valid.json";
import hris from "../../contracts/fixtures/source-hris.valid.json";
import talent from "../../contracts/fixtures/source-talent.valid.json";
import { MAX_BATCH_EVENTS, RAW_RECORD_COLUMNS, type RawRecord } from "../../src/shared/contracts.ts";
import { ATS_EVENT_TYPES, HRIS_EVENT_TYPES, type SourceId, TALENT_EVENT_TYPES } from "../../src/shared/sources.ts";
import { PREWARMED } from "../../src/worker/ingest/prewarm.ts";
import { normalize, toNdjson } from "../../src/worker/ingest/normalize.ts";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { bufferedRecords, bufferedRows, rollerStub } from "../helpers/landing.ts";
import { call } from "../helpers/tokens.ts";

afterEach(async () => {
  await reset();
});

const post = (source: string, who: Parameters<typeof call>[1], body: unknown) =>
  call(`/v1/ingest/${source}`, who, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("normalization (shared golden with pipeline/src/peoplelake/normalize.py)", () => {
  it.each(rawGolden.cases.map((c, i) => [`${i} ${c.source} ${c.raw_record.event_type}`, c] as const))(
    "%s",
    async (_name, c) => {
      const ctx = {
        receivedAt: rawGolden.context.received_at,
        requestId: rawGolden.context.ingest_request_id,
        producer: rawGolden.context.producer,
        newDeliveryId: () => c.raw_record.delivery_id,
      };
      const record = await normalize(c.source as SourceId, c.envelope as never, ctx);
      expect(record).toEqual(c.raw_record);
    },
  );

  it("hashes the canonical payload exactly like the canonical JSON golden", async () => {
    const hire = canonicalGolden.cases.find((g) => g.name === "hris hire payload");
    const envelope = { ...hris.events[0], data: hire?.value };
    const record = await normalize("hris", envelope as never, { receivedAt: "2026-10-10T00:00:00.000Z", requestId: "r", producer: "p" });
    expect(record.payload).toBe(hire?.canonical);
    expect(record.payload_sha256).toBe(hire?.sha256);
  });
});

describe("POST /v1/ingest/:source", () => {
  it.each([
    ["hris", "hris", hris],
    ["ats", "ats", ats],
    ["talent", "talent", talent],
  ] as const)("accepts a valid %s batch with its own source token", async (source, who, body) => {
    const res = await post(source, who, body);
    expect(res.status).toBe(202);
    const json = (await res.json()) as { request_id: string; accepted: number };
    const items = Object.values(body)[0] as unknown[];
    expect(json.accepted).toBe(items.length);
    const buffered = await bufferedRecords();
    expect(buffered).toHaveLength(items.length);
    expect(new Set(buffered.map((r) => r.ingest_request_id))).toEqual(new Set([json.request_id]));
    expect(buffered.every((r) => r.source === source && r.producer === "peoplelake-ingest/0.1.0")).toBe(true);
  });

  it("refuses a source token posting to another source, and non-source principals", async () => {
    expect((await post("ats", "hris", ats)).status).toBe(403);
    expect((await post("hris", "runner", hris)).status).toBe(403);
    expect((await post("hris", "operator", hris)).status).toBe(403);
    expect(await bufferedRecords()).toHaveLength(0);
  });

  it("rejects the whole batch with per-index reasons when one item is invalid", async () => {
    const events = structuredClone(hris.events) as Record<string, unknown>[];
    expect(events[0]?.["eventType"]).toBe("worker.hired");
    (events[0]?.["data"] as Record<string, unknown>)["fte_bp"] = 0.8;
    delete events[5]?.["workerId"];
    const res = await post("hris", "hris", { events });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { accepted: number; rejected: { index: number; reasons: string[] }[] };
    expect(json.accepted).toBe(0);
    expect(json.rejected.map((r) => r.index)).toEqual([0, 5]);
    expect(json.rejected[0]?.reasons.join(" ")).toContain("data.fte_bp");
    expect(await bufferedRecords()).toHaveLength(0);
  });

  it("enforces the 50-event (Workers Free CPU) and 1 MiB limits", async () => {
    expect(MAX_BATCH_EVENTS).toBe(50);
    const tooMany = { events: Array.from({ length: 51 }, () => hris.events[0]) };
    const refused = await post("hris", "hris", tooMany);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain("50");
    const fifty = { events: Array.from({ length: 50 }, () => hris.events[0]) };
    expect(await (await post("hris", "hris", fifty)).json()).toMatchObject({ accepted: 50 });
    const huge = { events: [{ ...hris.events[0], padding: "x".repeat(1024 * 1024) }] };
    expect((await post("hris", "hris", huge)).status).toBe(413);
    const invalidJson = await call("/v1/ingest/hris", "hris", { method: "POST", body: "{not json" });
    expect(invalidJson.status).toBe(400);
    expect((await post("crm", "hris", hris)).status).toBe(404);
  });

  it("mints a new delivery_id for every record, even for the same event in one request", async () => {
    const res = await post("talent", "talent", { items: [talent.items[0], talent.items[0]] });
    expect(res.status).toBe(202);
    const buffered: RawRecord[] = await bufferedRecords();
    expect(buffered).toHaveLength(2);
    expect(buffered[0]?.event_id).toBe(buffered[1]?.event_id);
    expect(buffered[0]?.delivery_id).not.toBe(buffered[1]?.delivery_id);
    expect(buffered[0]?.payload_sha256).toBe(buffered[1]?.payload_sha256);
  });
});

describe("schema prewarm", () => {
  it("runs the whole ingest path for one envelope of every event type when the module is imported", () => {
    expect([...new Set(PREWARMED.hris)].sort()).toEqual([...HRIS_EVENT_TYPES].sort());
    expect([...new Set(PREWARMED.ats)].sort()).toEqual([...ATS_EVENT_TYPES].sort());
    expect([...new Set(PREWARMED.talent)].sort()).toEqual([...TALENT_EVENT_TYPES].sort());
    expect(PREWARMED.raw_record).toBe(true);
    expect(PREWARMED.normalized).toBe(18);
  });
});

describe("landing", () => {
  it("lands one request as one LandingRoller row and makes no Coordinator call", async () => {
    const res = await post("hris", "hris", hris);
    expect(res.status).toBe(202);
    const rows = await bufferedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(hris.events.length);
    const status = await coordinatorStub(env).status();
    expect(status["last_ingest_at"]).toBeNull();
    expect(status["landed_rolls"]).toBeNull();
  });

  it("writes NDJSON lines in RAW_RECORD_COLUMNS order", async () => {
    const record = rawGolden.cases[0]?.raw_record as RawRecord;
    const shuffled = Object.fromEntries(Object.entries(record).reverse()) as RawRecord;
    const line = toNdjson([shuffled]);
    expect(line.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(line) as object)).toEqual([...RAW_RECORD_COLUMNS]);
  });

  it("answers 503 landing_backpressure when the landing buffer is full and keeps nothing", async () => {
    await rollerStub().setTestLimits({ rollMaxBytes: 1 << 30, maxBufferBytes: 2048 });
    const res = await post("hris", "hris", hris);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "landing_backpressure", accepted: 0 });
    expect(await bufferedRecords()).toHaveLength(0);
  });
});
