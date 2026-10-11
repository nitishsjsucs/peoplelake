import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import raw from "../../contracts/golden/raw-records.json";
import type { RawRecord } from "../../src/shared/contracts.ts";
import { lakeEventMessage, rollKey, type SinkRoller } from "../../src/worker/lake/sink-roller.ts";
import { rollFiles, rollerStub } from "../helpers/sink.ts";
import { call } from "../helpers/tokens.ts";

afterEach(async () => {
  await reset();
});

const records = (n: number, offset = 0): RawRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    ...(raw.cases[(i + offset) % raw.cases.length]?.raw_record as RawRecord),
    delivery_id: `00000000-0000-4000-8000-${String(i + offset).padStart(12, "0")}`,
  }));

describe("SinkRoller (local stand-in for the Basin sink)", () => {
  it("buffers, arms an alarm and rolls one NDJSON file when the alarm fires", async () => {
    const stub = rollerStub();
    expect(await stub.append(records(7))).toEqual({ buffered: 7, rolled: false });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const files = await rollFiles();
    expect(files.map((f) => f.key)).toEqual([rollKey(1)]);
    expect(files[0]?.lines.map((l) => (JSON.parse(l) as RawRecord).delivery_id)).toEqual(records(7).map((r) => r.delivery_id));
    expect(await stub.buffered()).toBe(0);
  });

  it("rolls immediately at LOCAL_SINK_MAX_RECORDS and numbers files sequentially", async () => {
    const stub = rollerStub();
    expect((await stub.append(records(50))).rolled).toBe(true);
    await stub.append(records(3, 50));
    await stub.flush();
    const files = await rollFiles();
    expect(files.map((f) => [f.key, f.lines.length])).toEqual([
      [rollKey(1), 50],
      [rollKey(2), 3],
    ]);
  });

  it("rewrites the same key with a superset after a crash between put and delete", async () => {
    const stub = rollerStub();
    await stub.append(records(3));
    await expect(
      runInDurableObject(stub, async (instance: SinkRoller) => instance.roll({ crashAfterPut: true })),
    ).rejects.toThrow(/simulated crash/);
    const first = await rollFiles();
    expect(first.map((f) => [f.key, f.lines.length])).toEqual([[rollKey(1), 3]]);
    await stub.append(records(2, 3));
    await stub.flush();
    const second = await rollFiles();
    expect(second.map((f) => [f.key, f.lines.length])).toEqual([[rollKey(1), 5]]);
    expect(second[0]?.etag).not.toBe(first[0]?.etag);
    await stub.append(records(1, 5));
    await stub.flush();
    expect((await rollFiles()).map((f) => f.key)).toEqual([rollKey(1), rollKey(2)]);
  });

  it("builds lake events with the R2 notification fields", () => {
    expect(lakeEventMessage(rollKey(4), 123, "abc", new Date("2026-10-10T00:00:00Z"))).toEqual({
      account: "local",
      action: "PutObject",
      bucket: "peoplelake-lake-local",
      object: { key: "local-sink/raw_events/00000004.ndjson", size: 123, eTag: "abc" },
      eventTime: "2026-10-10T00:00:00.000Z",
    });
  });
});

describe("local-only sink routes", () => {
  it("lets the operator flush and the runner list and fetch roll files", async () => {
    await rollerStub().append(records(4));
    const flushed = await call("/internal/dev/sink/flush", "operator", { method: "POST" });
    expect(flushed.status).toBe(200);
    const listed = (await (await call("/internal/dev/sink/files", "runner")).json()) as { files: { key: string }[] };
    expect(listed.files.map((f) => f.key)).toEqual([rollKey(1)]);
    const after = (await (await call(`/internal/dev/sink/files?after=${rollKey(1)}`, "runner")).json()) as { files: unknown[] };
    expect(after.files).toEqual([]);
    const body = await (await call(`/internal/dev/sink/files/${rollKey(1)}`, "runner")).text();
    expect(body.trim().split("\n")).toHaveLength(4);
    expect((await call("/internal/dev/sink/flush", "runner", { method: "POST" })).status).toBe(403);
    expect((await call("/internal/dev/sink/files", "hris")).status).toBe(403);
  });

  it("does not exist in a production configuration", async () => {
    const { createApp } = await import("../../src/worker/app.ts");
    const { mountDevRoutes } = await import("../../src/worker/api/dev.ts");
    const app = createApp(mountDevRoutes);
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
    };
    for (const path of ["/internal/dev/sink/files", "/internal/dev/sink/flush"]) {
      const res = await app.fetch(new Request(`https://peoplelake.example.workers.dev${path}`, { method: "POST" }), productionEnv);
      expect(res.status).toBe(404);
    }
  });
});
