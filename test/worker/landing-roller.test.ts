import { env, reset, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import raw from "../../contracts/golden/raw-records.json";
import type { RawRecord } from "../../src/shared/contracts.ts";
import { PRODUCTION_GUARDS } from "../../src/shared/free-budget.ts";
import { toNdjson } from "../../src/worker/ingest/normalize.ts";
import { lakeEventMessage, type LandingRoller, rollKey } from "../../src/worker/lake/landing-roller.ts";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { bufferedRows, rollerStub, rollFiles } from "../helpers/landing.ts";
import { call } from "../helpers/tokens.ts";

beforeEach(async () => {
  // Lake events reach the queue consumer; keep it from starting Workflow instances.
  await coordinatorStub(env).setTestOptions({ startWorkflows: false });
});

afterEach(async () => {
  await reset();
});

const records = (n: number, offset = 0): RawRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    ...(raw.cases[(i + offset) % raw.cases.length]?.raw_record as RawRecord),
    delivery_id: `00000000-0000-4000-8000-${String(i + offset).padStart(12, "0")}`,
  }));

/** Append one request of n records the way the ingest route does. */
const append = (n: number, offset = 0, at = Date.parse("2026-10-10T00:00:00Z") + offset) =>
  rollerStub().append(toNdjson(records(n, offset)), n, at);

const generation = () => coordinatorStub(env).generation();
const written = async () => (await rollerStub().sqlUsage()).rows_written;

describe("LandingRoller", () => {
  it("writes exactly one SQLite row per appended request, whatever its size", async () => {
    await append(1); // first call starts the object (DDL) outside the measurement
    for (const n of [1, 7, 50]) {
      const before = await written();
      expect((await append(n, 100)).accepted).toBe(true);
      expect((await written()) - before).toBe(1);
    }
    expect((await bufferedRows()).map((r) => r.length)).toEqual([1, 1, 7, 50]);
  });

  it("arms an alarm and rolls the buffer into one immutable file under the generation prefix", async () => {
    const stub = rollerStub();
    await append(3, 0);
    await append(4, 3);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const gen = await generation();
    const files = await rollFiles();
    expect(files.map((f) => f.key)).toEqual([rollKey(gen, 1)]);
    expect(files[0]?.key).toMatch(/^landing\/raw_events\/g\d+\/r0000000001\.ndjson$/);
    expect(files[0]?.lines.map((l) => (JSON.parse(l) as RawRecord).delivery_id)).toEqual(records(7).map((r) => r.delivery_id));
    expect(files[0]?.body).toBe(toNdjson(records(3, 0)) + toNdjson(records(4, 3)));
    expect((await stub.status()).buffered_requests).toBe(0);
    expect((await stub.status()).buffered_bytes).toBe(0);
  });

  it("writes at most 6 rows plus one delete per buffered request for a roll", async () => {
    const stub = rollerStub();
    for (let i = 0; i < 5; i++) await append(10, i * 10);
    const before = await written();
    expect((await stub.flush()).rolls).toHaveLength(1);
    expect((await written()) - before).toBeLessThanOrEqual(6 + 5);
  });

  it("repeats a roll interrupted after the put under the same key with byte-identical content", async () => {
    const stub = rollerStub();
    await append(3);
    await expect(runInDurableObject(stub, async (instance: LandingRoller) => instance.roll({ crashAfterPut: true }))).rejects.toThrow(
      /simulated crash/,
    );
    const first = await rollFiles();
    expect(first).toHaveLength(1);
    await append(2, 3); // arrives after the plan: it belongs to the next roll
    expect((await stub.status()).pending_roll).toBe(true);
    const { rolls } = await stub.flush();
    const gen = await generation();
    expect(rolls.map((r) => r.key)).toEqual([rollKey(gen, 1), rollKey(gen, 2)]);
    const second = await rollFiles();
    expect(second[0]?.etag).toBe(first[0]?.etag);
    expect(second[0]?.body).toBe(first[0]?.body);
    expect(second.map((f) => f.lines.length)).toEqual([3, 2]);
  });

  it("rolls once for concurrent triggers and numbers keys strictly increasing", async () => {
    const stub = rollerStub();
    await append(4);
    const [a, b] = await runInDurableObject(stub, async (instance: LandingRoller) => Promise.all([instance.roll(), instance.roll()]));
    expect(a?.key).toBe(b?.key);
    expect(await runDurableObjectAlarm(stub)).toBe(true); // the alarm finds nothing left to roll
    await append(1, 10);
    await stub.flush();
    await append(1, 11);
    await stub.flush();
    const keys = (await rollFiles()).map((f) => f.key);
    expect(keys).toHaveLength(3);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(3);
  });

  it("notes every roll with the Coordinator and sends one lake event per roll", async () => {
    const stub = rollerStub();
    for (let i = 0; i < 3; i++) {
      await append(2, i * 2, Date.parse("2026-10-10T00:00:00Z") + i * 1000);
      await stub.flush();
    }
    const status = await coordinatorStub(env).status();
    const gen = await generation();
    expect(status["landed_rolls"]).toBe("3");
    expect(status["landed_records"]).toBe("6");
    expect(status["landed_through"]).toBe(rollKey(gen, 3));
    expect((status["last_roll"] as { requests: number }).requests).toBe(1);
    const roller = await stub.status();
    expect(roller.rolls_since_start).toBe(3);
    expect(roller.lake_events_since_start).toBe(3);
  });

  const bytes = (n: number, offset: number) => new TextEncoder().encode(toNdjson(records(n, offset))).byteLength;

  it("rolls at once when the buffer reaches LANDING_ROLL_MAX_BYTES", async () => {
    const stub = rollerStub();
    await stub.setTestLimits({ rollMaxBytes: bytes(10, 0) + bytes(10, 10), maxBufferBytes: 1 << 20 });
    expect(await append(10, 0)).toMatchObject({ accepted: true, rolled: false });
    expect(await append(10, 10)).toMatchObject({ accepted: true, rolled: true });
    expect((await rollFiles()).map((f) => f.lines.length)).toEqual([20]);
  });

  it("refuses an append with landing_backpressure above LANDING_MAX_BUFFER_BYTES", async () => {
    const stub = rollerStub();
    const full = bytes(10, 0) + bytes(10, 10);
    await stub.setTestLimits({ rollMaxBytes: 1 << 20, maxBufferBytes: full });
    expect((await append(10, 0)).accepted).toBe(true);
    expect((await append(10, 10)).accepted).toBe(true);
    expect(await append(10, 20)).toEqual({ accepted: false, reason: "landing_backpressure", buffered_bytes: full });
    expect(await bufferedRows()).toHaveLength(2);
  });

  it("builds lake events with the R2 notification fields", () => {
    expect(lakeEventMessage("peoplelake-lake", rollKey(1790812800, 4), 123, "abc", new Date("2026-10-10T00:00:00Z"))).toEqual({
      account: "peoplelake",
      action: "PutObject",
      bucket: "peoplelake-lake",
      object: { key: "landing/raw_events/g1790812800/r0000000004.ndjson", size: 123, eTag: "abc" },
      eventTime: "2026-10-10T00:00:00.000Z",
    });
  });
});

describe("landing routes", () => {
  it("lets the runner list landing rolls after a cursor under a prefix and fetch them", async () => {
    const stub = rollerStub();
    await append(4);
    await stub.flush();
    await append(2, 4);
    const flushed = await call("/internal/dev/landing/flush", "operator", { method: "POST" });
    expect(flushed.status).toBe(200);
    const gen = await generation();
    const prefix = `landing/raw_events/g${gen}/`;
    const listed = (await (await call(`/internal/lake/files?prefix=${prefix}`, "runner")).json()) as { files: { key: string }[]; truncated: boolean };
    expect(listed.files.map((f) => f.key)).toEqual([rollKey(gen, 1), rollKey(gen, 2)]);
    expect(listed.truncated).toBe(false);
    const after = (await (await call(`/internal/lake/files?prefix=${prefix}&after=${rollKey(gen, 1)}`, "runner")).json()) as { files: { key: string }[] };
    expect(after.files.map((f) => f.key)).toEqual([rollKey(gen, 2)]);
    const other = (await (await call("/internal/lake/files?prefix=landing/raw_events/g1/", "operator")).json()) as { files: unknown[] };
    expect(other.files).toEqual([]);
    expect((await call("/internal/lake/files?prefix=reports/", "runner")).status).toBe(400);
    const body = await (await call(`/internal/lake/files/${rollKey(gen, 1)}`, "runner")).text();
    expect(body.trim().split("\n")).toHaveLength(4);
    expect((await call("/internal/lake/files/reports/metrics/latest.json", "runner")).status).toBe(404);
    expect((await call("/internal/dev/landing/flush", "runner", { method: "POST" })).status).toBe(403);
    expect((await call("/internal/lake/files", "hris")).status).toBe(403);
    expect((await call("/internal/lake/files", "viewer")).status).toBe(403);
  });

  it("mounts the lake file routes in production too, and the flush route only locally", async () => {
    const { createApp } = await import("../../src/worker/app.ts");
    const { mountDevRoutes } = await import("../../src/worker/api/dev.ts");
    const { mountInternalApi } = await import("../../src/worker/api/internal.ts");
    const app = createApp((a) => {
      mountInternalApi(a);
      mountDevRoutes(a);
    });
    const productionEnv = {
      ...env,
      ENVIRONMENT: "production",
      AUTH_MODE: "access",
      LAKE_MODE: "basin",
      RUNNER_DISPATCH: "cloudrun",
      RUNS_ENABLED: "false",
      EVAL_FAULTS_ENABLED: "false",
      ACCESS_TEAM_DOMAIN: "https://peoplelake.cloudflareaccess.com",
      ACCESS_AUD: "aud",
      ...Object.fromEntries(Object.entries(PRODUCTION_GUARDS).map(([k, v]) => [k, String(v)])),
    };
    const flush = await app.fetch(new Request("https://peoplelake.example.workers.dev/internal/dev/landing/flush", { method: "POST" }), productionEnv);
    expect(flush.status).toBe(404);
    // Without an Access JWT the lake routes answer 401 (they exist), not 404.
    const files = await app.fetch(new Request("https://peoplelake.example.workers.dev/internal/lake/files"), productionEnv);
    expect(files.status).toBe(401);
  });

  it("answers 404 for the old sink routes", async () => {
    expect((await call("/internal/dev/sink/files", "runner")).status).toBe(404);
    expect((await SELF.fetch("http://127.0.0.1/internal/dev/sink/flush", { method: "POST" })).status).toBe(401);
  });
});
