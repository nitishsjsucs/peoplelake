import { env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coordinatorStub, runIdFor } from "../../src/worker/orchestration/coordinator.ts";
import { loadOk } from "../helpers/runner.ts";

const c = () => coordinatorStub(env);
const input = { from_snapshot: null, full_refresh: false };

beforeEach(async () => {
  await c().setTestOptions({ startWorkflows: false });
});

afterEach(async () => {
  await reset();
});

async function newRun(reason = "test") {
  const res = await c().requestRun(reason);
  if (!res.run_id) throw new Error("no run");
  return res.run_id;
}

describe("Coordinator runs", () => {
  it("run ids and load sequences carry the generation", async () => {
    const generation = await c().generation();
    const runId = await newRun();
    expect(runId).toBe(runIdFor(generation, 1));
    expect(runId).toMatch(/^r-[0-9a-z]+-000001$/);
    const plan = await c().openRun(runId);
    expect(plan.load_seq).toBe(generation * 1_000_000 + 1);
    expect(plan.wait_timeout_seconds).toBe(20 + 10 + 60);
  });

  it("is single-flight and a pending replay wins over a pending incremental run", async () => {
    const first = await newRun();
    expect(await c().requestRun("again")).toEqual({ run_id: first, started: false, reason: "single_flight" });
    await c().requestRun("replay", "replay");
    await c().requestRun("incremental again");
    expect((await c().status())["pending_mode"]).toBe("replay");
    c().failRun(first, "test");
    const released = await c().releaseRun(first);
    expect(released.released).toBe(true);
    expect(released.next?.started).toBe(true);
    const next = await c().getRun(released.next?.run_id ?? "");
    expect(next?.run.mode).toBe("replay");
    expect(next?.run.reason).toBe("pending");
    expect((await c().status())["pending_mode"]).toBeNull();
  });

  it("advances the watermark and transformed_through_seq only on commit, idempotently", async () => {
    const runId = await newRun();
    const commit = {
      from_snapshot: null,
      to_snapshot: "s-1",
      transformed_through_seq: 42,
      rows_inserted: 3,
      duplicates_skipped: 0,
      transform_skipped: false,
      digests: { dim_job: "a" },
      checks: { error: {}, warn: {} },
      metrics_key: "reports/metrics/x.json",
    };
    expect((await c().status())["watermark"]).toBeNull();
    expect(await c().commitRun(runId, commit)).toEqual({ committed: true, duplicate: false });
    expect(await c().commitRun(runId, { ...commit, to_snapshot: "s-2" })).toEqual({ committed: true, duplicate: true });
    const status = await c().status();
    expect(status["watermark"]).toBe("s-1");
    expect(status["transformed_through_seq"]).toBe("42");
    await c().releaseRun(runId);
    const failedRun = await newRun();
    await c().failRun(failedRun, "boom");
    expect(await c().commitRun(failedRun, { ...commit, to_snapshot: "s-3" })).toEqual({ committed: false, duplicate: false });
    expect((await c().status())["watermark"]).toBe("s-1");
    const plan = await c().openRun(failedRun);
    expect(plan.previous.digests).toEqual({ dim_job: "a" });
  });

  it("attributes freshness of a failed run's load to the next committed run", async () => {
    const one = await newRun();
    const spec = await c().enqueueJob(one, "load", 1, input);
    await c().claimJob("w");
    await c().completeJob(spec.job_id, loadOk(spec));
    await c().failRun(one, "transform failed");
    await c().releaseRun(one);
    const two = await newRun();
    expect((await c().freshnessRows(0))[0]?.published_by).toBeNull();
    await c().commitRun(two, {
      from_snapshot: null, to_snapshot: "s", transformed_through_seq: 1, rows_inserted: 0, duplicates_skipped: 0,
      transform_skipped: false, digests: null, checks: null, metrics_key: null,
    });
    const rows = await c().freshnessRows(0);
    expect(rows.map((r) => [r.run_id, r.events, r.published_by])).toEqual([[one, 10, two]]);
  });
});

describe("Coordinator jobs and leases", () => {
  it("enqueue is idempotent, claim takes the oldest job and sets a lease", async () => {
    const runId = await newRun();
    const t0 = Date.now();
    const a = await c().enqueueJob(runId, "load", 1, input, t0);
    expect(await c().enqueueJob(runId, "load", 1, { ...input, full_refresh: true }, t0 + 1)).toEqual(a);
    const claimed = await c().claimJob("w1", t0 + 5);
    expect(claimed?.job_id).toBe(`${runId}-load-a1`);
    expect(await c().claimJob("w2", t0 + 6)).toBeNull();
    const row = await c().jobStatus(a.job_id);
    expect([row?.status, row?.claimed_by, row?.lease_until]).toEqual(["claimed", "w1", t0 + 5 + 20_000]);
    expect(await c().heartbeat(a.job_id, "w2", t0 + 7)).toEqual({ ok: false, lease_until: null });
    expect(await c().heartbeat(a.job_id, "w1", t0 + 8)).toEqual({ ok: true, lease_until: t0 + 8 + 20_000 });
  });

  it("returns duplicate for a second result and sends only one event", async () => {
    const runId = await newRun();
    const spec = await c().enqueueJob(runId, "load", 1, input);
    await c().claimJob("w");
    expect(await c().completeJob(spec.job_id, loadOk(spec))).toEqual({ duplicate: false, known: true });
    expect(await c().completeJob(spec.job_id, loadOk(spec))).toEqual({ duplicate: true, known: true });
    const status = await c().status();
    expect(status["events_sent"]).toBe("1");
    expect(status["duplicate_results"]).toBe("1");
    expect(await c().completeJob("nope", {})).toEqual({ duplicate: false, known: false });
  });

  it("catches sendEvent to an instance that does not exist or has finished", async () => {
    const runId = await newRun();
    const spec = await c().enqueueJob(runId, "load", 1, input);
    await c().claimJob("w");
    await c().setTestOptions({ startWorkflows: true });
    await expect(c().completeJob(spec.job_id, loadOk(spec))).resolves.toEqual({ duplicate: false, known: true });
    const status = await c().status();
    expect(status["event_errors"]).toBe("1");
    expect(String(status["last_event_error"])).toContain(`load-result-a1 -> ${runId}`);
  });

  it("expires queued jobs after the claim timeout and claimed jobs after the lease", async () => {
    const runId = await newRun();
    const t0 = Date.now();
    const load = await c().enqueueJob(runId, "load", 1, input, t0);
    const transform = await c().enqueueJob(runId, "transform", 1, input, t0 + 1);
    await c().claimJob("w", t0 + 2); // claims the load
    expect((await c().sweep(t0 + 9_000)).expired).toBe(0);
    expect((await c().sweep(t0 + 10_001)).expired).toBe(1); // the queued transform: claim timeout
    expect((await c().jobStatus(transform.job_id))?.status).toBe("expired");
    expect((await c().sweep(t0 + 20_003)).expired).toBe(1); // the claimed load: lease
    const expired = await c().jobStatus(load.job_id);
    expect(expired?.status).toBe("expired");
    expect(JSON.parse(expired?.result_json ?? "{}")).toMatchObject({ status: "expired", error: "lease expired" });
    expect((await c().status())["events_sent"]).toBe("2");
  });

  it("fails and releases runs older than RUN_TIMEOUT_MINUTES", async () => {
    const runId = await newRun();
    const res = await c().sweep(Date.now() + 11 * 60_000);
    expect(res.timed_out).toBe(1);
    expect((await c().getRun(runId))?.run).toMatchObject({ status: "failed", error: "run timeout" });
    expect((await c().status())["active_run_id"]).toBeNull();
  });

  it("resolves a timed-out wait: running under a live lease, otherwise expired now", async () => {
    const runId = await newRun();
    const t0 = Date.now();
    const spec = await c().enqueueJob(runId, "transform", 1, input, t0);
    await c().claimJob("w", t0);
    expect(await c().resolveWait(spec.job_id, t0 + 1000)).toEqual({ state: "running", lease_until: t0 + 20_000 });
    const done = await c().resolveWait(spec.job_id, t0 + 30_000);
    expect(done.state).toBe("done");
    expect((await c().jobStatus(spec.job_id))?.status).toBe("expired");
  });
});

describe("Coordinator dispatch window and faults", () => {
  it("does not dispatch while a runner was seen recently or right after a dispatch without a claim", async () => {
    const t0 = 1_800_000_000_000;
    expect(await c().shouldDispatch(t0)).toBe(true);
    await c().claimJob("w", t0);
    expect(await c().shouldDispatch(t0 + 59_000)).toBe(false);
    expect(await c().shouldDispatch(t0 + 61_000)).toBe(true);
    await c().noteDispatch("job", "op-1", t0 + 61_000);
    expect(await c().shouldDispatch(t0 + 120_000)).toBe(false);
    expect(await c().shouldDispatch(t0 + 152_000)).toBe(true);
  });

  it("embeds faults only into the matching run, job kind and attempt", async () => {
    await c().installFaults([
      { run_seq: 1, kind: "crash_after_load" },
      { run_seq: 1, kind: "fail_transform_model", model: "fct_workforce_monthly" },
      { run_seq: 2, kind: "skip_claim" },
    ]);
    const runId = await newRun();
    expect((await c().enqueueJob(runId, "load", 1, input)).faults).toEqual([{ run_seq: 1, kind: "crash_after_load" }]);
    expect((await c().enqueueJob(runId, "load", 2, input)).faults).toBeUndefined();
    expect((await c().enqueueJob(runId, "transform", 1, input)).faults).toEqual([
      { run_seq: 1, kind: "fail_transform_model", model: "fct_workforce_monthly" },
    ]);
  });

  it("rewind_watermark makes openRun read from a snapshot committed runs earlier", async () => {
    await c().installFaults([{ run_seq: 4, kind: "rewind_watermark", snapshots: 2 }]);
    for (const snap of ["s1", "s2", "s3"]) {
      const runId = await newRun();
      await c().commitRun(runId, {
        from_snapshot: null, to_snapshot: snap, transformed_through_seq: 1, rows_inserted: 1, duplicates_skipped: 0,
        transform_skipped: false, digests: null, checks: null, metrics_key: null,
      });
      await c().releaseRun(runId);
    }
    const fourth = await newRun();
    expect((await c().openRun(fourth)).from_snapshot).toBe("s1");
    await c().failRun(fourth, "x");
    await c().releaseRun(fourth);
    expect((await c().openRun(await newRun())).from_snapshot).toBe("s3");
  });

  it("consumes the commit_step_error fault exactly once", async () => {
    await c().installFaults([{ run_seq: 1, kind: "commit_step_error" }]);
    const runId = await newRun();
    expect(await c().consumeCommitFault(runId)).toBe(true);
    expect(await c().consumeCommitFault(runId)).toBe(false);
    expect((await c().status())["faults_fired"]).toBe("1");
  });

  it("notes each landing roll once, in key order, and the cron starts a run only for a roll noted after the last run started", async () => {
    const roll = (n: number, at: string) => ({
      key: `landing/raw_events/g1/r${String(n).padStart(10, "0")}.ndjson`,
      etag: `e${n}`,
      size: 100,
      records: 5,
      requests: 2,
      first_received_at: at,
      last_received_at: at,
    });
    const finish = async () => {
      const runId = (await c().status())["active_run_id"] as string;
      await c().failRun(runId, "x");
      await c().releaseRun(runId);
    };
    const t0 = Date.now();
    expect((await c().tick(t0)).requested).toEqual([]);
    expect(await c().noteRoll(roll(1, "2026-10-10T00:00:01.000Z"), t0)).toEqual({ noted: true });
    expect(await c().noteRoll(roll(1, "2026-10-10T00:00:01.000Z"), t0)).toEqual({ noted: false });
    const status = await c().status();
    expect(status["landed_through"]).toBe(roll(1, "").key);
    expect(status["landed_rolls"]).toBe("1");
    expect(status["landed_records"]).toBe("5");
    expect(status["last_ingest_at"]).toBe(String(Date.parse("2026-10-10T00:00:01.000Z")));
    expect((await c().tick(t0 + 1000)).requested).toEqual(["cron"]);
    await finish();
    expect((await c().tick(t0 + 300_000)).requested).toEqual([]);
    await c().noteRoll(roll(2, "2026-10-10T00:01:01.000Z"), t0 + 400_000);
    expect((await c().tick(t0 + 400_001)).requested).toEqual(["cron"]);
    expect((await c().status())["landed_rolls"]).toBe("2");
  });
});

describe("Coordinator and Workflow instances", () => {
  it("requestRun reuses an existing instance with the same id instead of failing", async () => {
    await c().setTestOptions({ startWorkflows: true });
    const runId = await c().nextRunId();
    await env.WAREHOUSE_RUN.create({ id: runId, params: { run_id: runId, mode: "incremental", reason: "pre-created" } });
    await expect(c().requestRun("retry")).resolves.toEqual({ run_id: runId, started: true });
  });
});
