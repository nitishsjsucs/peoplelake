import { createExecutionContext, createMessageBatch, env, getQueueResult, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { lakeEventMessage, rollKey } from "../../src/worker/lake/landing-roller.ts";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";

beforeEach(async () => {
  await coordinatorStub(env).setTestOptions({ startWorkflows: false });
});

afterEach(async () => {
  await reset();
});

describe("lake events queue consumer", () => {
  it("treats only landing roll keys as lake events, acks every message, counts malformed ones and requests one run", async () => {
    const batch = createMessageBatch<unknown>("peoplelake-lake-events", [
      { id: "1", timestamp: new Date(), attempts: 1, body: lakeEventMessage("peoplelake-lake-local", rollKey(7, 1), 10, "e1", new Date("2026-10-10T00:00:01Z")) },
      { id: "2", timestamp: new Date(), attempts: 1, body: lakeEventMessage("peoplelake-lake-local", rollKey(7, 2), 10, "e2", new Date("2026-10-10T00:00:02Z")) },
      { id: "3", timestamp: new Date(), attempts: 1, body: { nonsense: true } },
      { id: "4", timestamp: new Date(), attempts: 1, body: { object: { key: "other/file.parquet" } } },
      { id: "5", timestamp: new Date(), attempts: 1, body: { object: { key: "__r2_data_catalog/x/metadata/00002-abc.metadata.json" }, eventTime: "2026-10-10T00:00:00Z" } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.retryMessages).toEqual([]);
    const status = await coordinatorStub(env).status();
    expect(status["malformed_lake_events"]).toBe("1");
    expect(status["last_lake_event_at"]).toBe("2026-10-10T00:00:02.000Z");
    expect(status["active_run_id"]).not.toBeNull();
    expect(status["run_seq"]).toBe("1");
  });

  it("ignores Iceberg metadata keys: there is no R2 notification path any more", async () => {
    const batch = createMessageBatch<unknown>("peoplelake-lake-events", [
      { id: "m", timestamp: new Date(), attempts: 1, body: { object: { key: "__r2_data_catalog/x/metadata/00002-abc.metadata.json" }, eventTime: "2026-10-10T00:00:00Z" } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["m"]);
    expect((await coordinatorStub(env).status())["run_seq"]).toBeNull();
  });
});
