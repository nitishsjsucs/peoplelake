import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BQ_TRANSFORM_RESERVE_BYTES, backoffMinutes } from "../../src/shared/free-budget.ts";
import { type Coordinator, coordinatorStub, runIdFor } from "../../src/worker/orchestration/coordinator.ts";
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
    expect(await c().shouldDispatch(t0 + 9_000)).toBe(false);
    expect(await c().shouldDispatch(t0 + 11_000)).toBe(true);
    await c().noteDispatch("job", "op-1", t0 + 11_000);
    expect(await c().shouldDispatch(t0 + 60_000)).toBe(false);
    expect(await c().shouldDispatch(t0 + 102_000)).toBe(true);
  });

  it("dispatches a job enqueued after the runner stopped polling, without waiting for the claim timeout", async () => {
    // The Cloud Run runner polls every 2 s and exits after 15 idle seconds. Seen at t0, gone by t0+15 s
    // even without saying so (a crash): a job enqueued at t0+30 s is dispatched at once.
    const runId = await newRun();
    const t0 = Date.now();
    expect(await c().claimJob("w", t0)).toBeNull();
    await c().enqueueJob(runId, "load", 1, input, t0 + 30_000);
    expect(await c().shouldDispatch(t0 + 30_000)).toBe(true);
  });

  it("a runner at its idle exit stays while a job is queued and is forgotten at once otherwise", async () => {
    const runId = await newRun();
    const t0 = Date.now();
    expect(await c().claimJob("w", t0)).toBeNull();
    // Nothing queued: the runner may exit and the next job is dispatched immediately, not 10 s later.
    expect(await c().runnerIdle("w", t0 + 15_000)).toEqual({ exit: true });
    expect((await c().status())["runner_last_seen_at"]).toBeNull();
    await c().enqueueJob(runId, "load", 1, input, t0 + 15_500);
    expect(await c().shouldDispatch(t0 + 15_500)).toBe(true);
    // A job queued after the runner's last poll (no dispatch, the runner was seen): the runner stays.
    expect(await c().claimJob("w", t0 + 16_000)).not.toBeNull();
    await c().enqueueJob(runId, "transform", 1, input, t0 + 20_000);
    expect(await c().shouldDispatch(t0 + 20_000)).toBe(false);
    expect(await c().runnerIdle("w", t0 + 21_000)).toEqual({ exit: false });
    expect((await c().claimJob("w", t0 + 22_000))?.kind).toBe("transform");
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

  it("notes each landing roll once, in key order", async () => {
    const t0 = Date.now();
    expect(await c().noteRoll(roll(1, "2026-10-10T00:00:01.000Z"), t0)).toEqual({ noted: true });
    expect(await c().noteRoll(roll(1, "2026-10-10T00:00:01.000Z"), t0)).toEqual({ noted: false });
    const status = await c().status();
    expect(status["landed_through"]).toBe(roll(1, "").key);
    expect(status["landed_rolls"]).toBe("1");
    expect(status["landed_records"]).toBe("5");
    expect(status["last_ingest_at"]).toBe(String(Date.parse("2026-10-10T00:00:01.000Z")));
  });
});

const roll = (n: number, at: string) => ({
  key: `landing/raw_events/g1/r${String(n).padStart(10, "0")}.ndjson`,
  etag: `e${n}`,
  size: 100,
  records: 5,
  requests: 2,
  first_received_at: at,
  last_received_at: at,
});

const commitInput = (landing_through: string | null = null) => ({
  from_snapshot: null,
  to_snapshot: "s",
  transformed_through_seq: 1,
  rows_inserted: 1,
  duplicates_skipped: 0,
  transform_skipped: false,
  digests: null,
  checks: null,
  metrics_key: null,
  landing_through,
});

const MIN = 60_000;

describe("Coordinator Free plan guards", () => {
  it("the cron backstop requests a run only while the landed roll is past the committed cursor", async () => {
    const t0 = Date.now();
    expect((await c().tick(t0)).requested).toEqual([]);
    await c().noteRoll(roll(1, "2026-10-10T00:00:01.000Z"), t0);
    const first = await c().tick(t0 + 1000);
    expect(first.requested).toEqual(["cron"]);
    const runId = (await c().status())["active_run_id"] as string;
    expect((await c().tick(t0 + 2000)).requested).toEqual([]); // a run is active
    await c().commitRun(runId, commitInput(roll(1, "").key), t0 + 3000);
    await c().releaseRun(runId, t0 + 3000);
    expect((await c().status())["committed_through"]).toBe(roll(1, "").key);
    expect((await c().tick(t0 + 5 * MIN)).requested).toEqual([]);
    await c().noteRoll(roll(2, "2026-10-10T00:01:01.000Z"), t0 + 6 * MIN);
    expect((await c().tick(t0 + 10 * MIN)).requested).toEqual(["cron"]);
  });

  it("backs off automatic runs 5, 10, 20, 40 minutes up to 360 after failures; operators bypass; a commit resets", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => backoffMinutes(k, 5, 360))).toEqual([5, 10, 20, 40, 80, 160, 320, 360, 360]);
    await c().setTestOptions({ guards: { failureBackoffBaseMinutes: 5, failureBackoffMaxMinutes: 360 } });
    const t0 = Date.now();
    const fail = async (at: number) => {
      const res = await c().requestRun("lake-event", "incremental", at);
      expect(res.started).toBe(true);
      await c().failRun(res.run_id ?? "", "boom", at + 1000);
      await c().releaseRun(res.run_id ?? "", at + 1000);
      return at + 1000;
    };
    const f1 = await fail(t0);
    expect(await c().requestRun("lake-event", "incremental", f1 + 4 * MIN)).toMatchObject({ started: false, reason: "failure_backoff" });
    const f2 = await fail(f1 + 5 * MIN);
    expect(await c().requestRun("cron", "incremental", f2 + 9 * MIN)).toMatchObject({ started: false, reason: "failure_backoff" });
    expect((await c().budget(f2 + 9 * MIN)).runs.failure_backoff_until).toBe(f2 + 10 * MIN);
    const operator = await c().requestRun("manual", "incremental", f2 + 9 * MIN);
    expect(operator.started).toBe(true);
    await c().commitRun(operator.run_id ?? "", commitInput(), f2 + 9 * MIN + 1000);
    await c().releaseRun(operator.run_id ?? "", f2 + 9 * MIN + 1000);
    expect((await c().budget(f2 + 9 * MIN + 2000)).runs.consecutive_failures).toBe(0);
    expect((await c().requestRun("lake-event", "incremental", f2 + 9 * MIN + 2000)).started).toBe(true);
  });

  it("starts automatic runs at least RUN_MIN_INTERVAL_SECONDS apart; the alarm starts the pending one", async () => {
    await c().setTestOptions({ guards: { runMinIntervalSeconds: 240 } });
    const t0 = Date.now();
    const first = await c().requestRun("lake-event", "incremental", t0);
    expect(first.started).toBe(true);
    await c().commitRun(first.run_id ?? "", commitInput(), t0 + 30_000);
    await c().releaseRun(first.run_id ?? "", t0 + 30_000);
    expect(await c().requestRun("lake-event", "incremental", t0 + 60_000)).toMatchObject({ started: false, reason: "min_interval" });
    expect((await c().status())["pending_auto"]).toBe("1");
    expect((await c().sweep(t0 + 200_000)).timed_out).toBe(0);
    expect((await c().status())["active_run_id"]).toBeNull(); // still inside the interval
    await c().sweep(t0 + 240_000);
    const status = await c().status();
    expect(status["active_run_id"]).toBe(runIdFor(await c().generation(), 2));
    expect(status["pending_auto"]).toBeNull();
    expect((await c().getRun(status["active_run_id"] as string))?.run.reason).toBe("pending-auto");
    // Operator runs and replays are not held back by the interval.
    await c().failRun(status["active_run_id"] as string, "x", t0 + 241_000);
    await c().releaseRun(status["active_run_id"] as string, t0 + 241_000);
    expect((await c().requestRun("manual", "incremental", t0 + 242_000)).started).toBe(true);
  });

  it("never re-arms the alarm every second while a due pending automatic run waits for the active run", async () => {
    // A lake event inside the minimum interval leaves a pending automatic run; when it falls due while the
    // first run is still active, the alarm must sleep until a real deadline (here the 10-minute local run
    // timeout), and releasing the run starts the pending one at once.
    await c().setTestOptions({ guards: { runMinIntervalSeconds: 240 } });
    const t0 = Date.now();
    const first = await c().requestRun("lake-event", "incremental", t0);
    const firstId = first.run_id ?? "";
    expect(await c().requestRun("lake-event", "incremental", t0 + 60_000)).toMatchObject({ started: false, reason: "min_interval" });
    const before = (await c().sqlUsage()).rows_written;
    const alarmAfterSweep = await runInDurableObject(c(), async (instance: Coordinator, state) => {
      await state.storage.deleteAlarm(); // inside alarm() the fired alarm is gone
      await instance.sweep(t0 + 240_000);
      return state.storage.getAlarm();
    });
    expect((await c().status())["active_run_id"]).toBe(firstId);
    expect(alarmAfterSweep).toBe(t0 + 10 * MIN);
    expect((await c().sqlUsage()).rows_written - before).toBeLessThanOrEqual(2); // the alarm set counts as a row
    await c().commitRun(firstId, commitInput(), t0 + 250_000);
    const released = await c().releaseRun(firstId, t0 + 250_000);
    expect(released.next).toMatchObject({ started: true });
    expect((await c().getRun(released.next?.run_id ?? ""))?.run.reason).toBe("pending-auto");
    expect((await c().status())["pending_auto"]).toBeNull();
  });

  it("a run that ends before the pending automatic run is due arms the alarm for its due time", async () => {
    await c().setTestOptions({ guards: { runMinIntervalSeconds: 240 } });
    const t0 = Date.now();
    const first = await c().requestRun("lake-event", "incremental", t0);
    await c().requestRun("lake-event", "incremental", t0 + 60_000);
    const alarm = await runInDurableObject(c(), async (instance: Coordinator, state) => {
      await state.storage.deleteAlarm(); // e.g. an earlier deadline fired and the pending run was not counted
      await instance.commitRun(first.run_id ?? "", commitInput(), t0 + 100_000);
      expect((await instance.releaseRun(first.run_id ?? "", t0 + 100_000)).next).toBeNull();
      return state.storage.getAlarm();
    });
    expect(alarm).toBe(t0 + 240_000);
    expect((await c().status())["pending_auto"]).toBe("1");
  });

  it("caps automatic runs per UTC day", async () => {
    await c().setTestOptions({ guards: { autoRunsMaxPerDay: 2 } });
    const day = Date.parse("2026-10-10T08:00:00.000Z");
    for (let i = 0; i < 2; i++) {
      const res = await c().requestRun("lake-event", "incremental", day + i * MIN);
      expect(res.started).toBe(true);
      await c().commitRun(res.run_id ?? "", commitInput(), day + i * MIN + 1000);
      await c().releaseRun(res.run_id ?? "", day + i * MIN + 1000);
    }
    expect(await c().requestRun("lake-event", "incremental", day + 5 * MIN)).toMatchObject({ started: false, reason: "daily_cap" });
    expect((await c().budget(day + 5 * MIN)).runs.automatic_today).toBe(2);
    expect((await c().requestRun("manual", "incremental", day + 6 * MIN)).started).toBe(true);
    const runId = (await c().status())["active_run_id"] as string;
    await c().commitRun(runId, commitInput(), day + 7 * MIN);
    await c().releaseRun(runId, day + 7 * MIN);
    expect((await c().requestRun("lake-event", "incremental", Date.parse("2026-10-11T00:00:01.000Z"))).started).toBe(true);
  });

  it("the monthly BigQuery guard refuses a transform past the cap and allows it again next month", async () => {
    const cap = 10 * BQ_TRANSFORM_RESERVE_BYTES;
    await c().setTestOptions({ guards: { bqMonthlyBytesCap: cap } });
    const october = Date.parse("2026-10-20T00:00:00.000Z");
    expect((await c().transformBudget(october)).ok).toBe(true);
    const runId = await newRun();
    const load = await c().enqueueJob(runId, "load", 1, input, october);
    await c().claimJob("w", october);
    await c().completeJob(load.job_id, { ...loadOk(load), bytes_billed: 4 * BQ_TRANSFORM_RESERVE_BYTES }, october);
    const transform = await c().enqueueJob(runId, "transform", 1, input, october);
    await c().claimJob("w", october);
    await c().completeJob(transform.job_id, { status: "succeeded", dbt: { bytes_billed: 5 * BQ_TRANSFORM_RESERVE_BYTES } }, october);
    expect(await c().transformBudget(october)).toEqual({
      ok: true,
      month: "2026-10",
      bytes_billed: 9 * BQ_TRANSFORM_RESERVE_BYTES,
      reserve_bytes: BQ_TRANSFORM_RESERVE_BYTES,
      cap_bytes: cap,
    });
    const more = await c().enqueueJob(runId, "transform", 2, input, october);
    await c().claimJob("w", october);
    await c().completeJob(more.job_id, { status: "succeeded", dbt: { bytes_billed: 1 } }, october);
    expect((await c().transformBudget(october)).ok).toBe(false);
    expect((await c().transformBudget(Date.parse("2026-11-01T00:00:00.000Z"))).ok).toBe(true);
  });

  it("keeps a tick's rows read and a committed run's rows written flat with 10,000 runs and 20,000 jobs of history", async () => {
    const generation = await c().generation();
    await runInDurableObject(c(), async (_instance: Coordinator, state) => {
      const sql = state.storage.sql;
      const t = Date.parse("2026-01-01T00:00:00.000Z");
      for (let i = 1; i <= 10_000; i++) {
        const id = runIdFor(generation, i);
        sql.exec(
          "INSERT INTO runs (run_id, seq, load_seq, mode, reason, status, requested_at, started_at, finished_at, published_at, digests_json) VALUES (?, ?, ?, 'incremental', 'lake-event', 'committed', ?, ?, ?, ?, '{}')",
          id,
          i,
          generation * 1_000_000 + i,
          t + i * 1000,
          t + i * 1000,
          t + i * 1000 + 500,
          t + i * 1000 + 500,
        );
        for (const kind of ["load", "transform"]) {
          sql.exec(
            "INSERT INTO jobs (job_id, run_id, kind, attempt, status, input_json, created_at, finished_at) VALUES (?, ?, ?, 1, 'succeeded', '{}', ?, ?)",
            `${id}-${kind}-a1`,
            id,
            kind,
            t + i * 1000,
            t + i * 1000 + 100,
          );
        }
        sql.exec("INSERT INTO run_freshness (run_id, bucket_start_s, events, published_by, published_at) VALUES (?, ?, 10, ?, ?)", id, Math.floor((t + i * 1000) / 1000), id, t + i * 1000 + 500);
      }
      sql.exec("INSERT INTO state (key, value) VALUES ('run_seq', '10000') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    });
    const now = Date.now();
    const before = await c().sqlUsage();
    await c().tick(now);
    const afterTick = await c().sqlUsage();
    expect(afterTick.rows_read - before.rows_read).toBeLessThanOrEqual(100);

    const res = await c().requestRun("lake-event", "incremental", now);
    const runId = res.run_id ?? "";
    await c().openRun(runId);
    const load = await c().enqueueJob(runId, "load", 1, input, now);
    await c().claimJob("w", now);
    await c().completeJob(load.job_id, loadOk(load), now);
    const transform = await c().enqueueJob(runId, "transform", 1, input, now);
    await c().claimJob("w", now);
    await c().completeJob(transform.job_id, { job_id: transform.job_id, run_id: runId, attempt: 1, status: "succeeded" }, now);
    await c().commitRun(runId, { ...commitInput("landing/raw_events/g1/r0000000001.ndjson"), digests: { dim_job: "a" }, steps_used: 8 }, now);
    await c().releaseRun(runId, now);
    const afterRun = await c().sqlUsage();
    expect(afterRun.rows_written - afterTick.rows_written).toBeLessThanOrEqual(100);
    expect(afterRun.rows_read - afterTick.rows_read).toBeLessThanOrEqual(100); // measured: 47 read, 66 written (2 of them alarm sets)
    // The daily counters are persisted at most every 5 minutes (one row).
    await c().tick(now + 5 * MIN);
    const budget = await c().budget(now + 5 * MIN);
    expect(budget.sql.rows_written).toBeGreaterThan(0);
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
