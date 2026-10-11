import { env, introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { shouldSkipTransform } from "../../src/worker/orchestration/warehouse-run.ts";
import { LATEST_METRICS_KEY, runReportKey } from "../../src/worker/reports.ts";
import { failed, happy, loadOk, startRunner, transformOk, waitFor } from "../helpers/runner.ts";

afterEach(async () => {
  await reset();
});

const coordinator = () => coordinatorStub(env);

async function startRun(mode: "incremental" | "replay" = "incremental") {
  const runId = await coordinator().nextRunId();
  const instance = await introspectWorkflowInstance(env.WAREHOUSE_RUN, runId);
  await instance.modify(async (m) => {
    await m.disableRetryDelays();
  });
  const res = await coordinator().requestRun("test", mode);
  expect(res).toEqual({ run_id: runId, started: true });
  return { runId, instance };
}

describe("WarehouseRunWorkflow", () => {
  it("happy path: load, transform, verify, commit, release", async () => {
    const runner = startRunner(happy);
    const { runId, instance } = await startRun();
    await instance.waitForStatus("complete");
    const claimed = await runner.stop();
    expect(claimed.map((j) => j.job_id)).toEqual([`${runId}-load-a1`, `${runId}-transform-a1`]);
    expect(await instance.getOutput()).toEqual({
      run_id: runId,
      status: "committed",
      transform_skipped: false,
      rows_inserted: 10,
      load_attempts: 1,
      transform_attempts: 1,
    });
    const ledger = await coordinator().getRun(runId);
    expect(ledger?.run.status).toBe("committed");
    const status = await coordinator().status();
    expect(status["watermark"]).toBe(`snap-${runId}`);
    expect(status["active_run_id"]).toBeNull();
    expect(await env.REPORTS_BUCKET.get(LATEST_METRICS_KEY)).not.toBeNull();
    expect(await env.REPORTS_BUCKET.get(runReportKey(runId))).not.toBeNull();
    await instance.dispose();
  });

  it("load attempt 1 times out while queued and attempt 2 succeeds", async () => {
    const runId = await coordinator().nextRunId();
    const instance = await introspectWorkflowInstance(env.WAREHOUSE_RUN, runId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.forceEventTimeout({ name: "wait:load:a1" });
    });
    await coordinator().requestRun("test");
    await waitFor(async () => (await coordinator().jobStatus(`${runId}-load-a1`))?.status === "expired");
    const runner = startRunner(happy);
    await instance.waitForStatus("complete");
    const claimed = await runner.stop();
    expect(claimed.map((j) => j.job_id)).toEqual([`${runId}-load-a2`, `${runId}-transform-a1`]);
    expect(await instance.getOutput()).toMatchObject({ load_attempts: 2, transform_attempts: 1 });
    await instance.dispose();
  });

  it("an expired lease (runner crash) sends `expired`, attempt 2 succeeds, and the late attempt-1 result is ignored", async () => {
    let lateJob: Parameters<typeof loadOk>[0] | null = null;
    const runner = startRunner((job) => {
      if (job.kind === "load" && job.attempt === 1) {
        lateJob = job;
        return "drop"; // crash after load: no result
      }
      return happy(job);
    });
    const { runId, instance } = await startRun();
    await waitFor(async () => (await coordinator().jobStatus(`${runId}-load-a1`))?.status === "claimed");
    const swept = await coordinator().sweep(Date.now() + 25_000);
    expect(swept.expired).toBe(1);
    await instance.waitForStatus("complete");
    await runner.stop();
    expect(await instance.getOutput()).toMatchObject({ load_attempts: 2 });
    if (lateJob === null) throw new Error("attempt 1 was never claimed");
    const late = await coordinator().completeJob(`${runId}-load-a1`, loadOk(lateJob));
    expect(late).toEqual({ duplicate: true, known: true });
    expect((await coordinator().status())["lease_expirations"]).toBe("1");
    await instance.dispose();
  });

  it("a failed transform is retried as attempt 2", async () => {
    const runner = startRunner(async (job) => (job.kind === "transform" && job.attempt === 1 ? failed(job) : happy(job)));
    const { instance } = await startRun();
    await instance.waitForStatus("complete");
    await runner.stop();
    expect(await instance.getOutput()).toMatchObject({ transform_attempts: 2 });
    await instance.dispose();
  });

  it("three transform failures end errored with the run failed and released", async () => {
    const runner = startRunner(async (job) => (job.kind === "transform" ? failed(job) : happy(job)));
    const { runId, instance } = await startRun();
    await instance.waitForStatus("errored");
    await runner.stop();
    expect((await instance.getError()).message).toContain("transform did not succeed in 3 attempts");
    const ledger = await coordinator().getRun(runId);
    expect(ledger?.run.status).toBe("failed");
    expect(ledger?.jobs.filter((j) => j.kind === "transform").map((j) => j.status)).toEqual(["failed", "failed", "failed"]);
    expect((await coordinator().status())["active_run_id"]).toBeNull();
    expect((await coordinator().status())["watermark"]).toBeNull();
    await instance.dispose();
  });

  it("verify rejects error-level checks and nothing is committed", async () => {
    const runner = startRunner(async (job) =>
      job.kind === "transform" ? transformOk(job, { checksError: { recon_retro_corrections_applied: 2 } }) : happy(job),
    );
    const { runId, instance } = await startRun();
    await instance.waitForStatus("errored");
    await runner.stop();
    expect((await instance.getError()).message).toContain("recon_retro_corrections_applied");
    expect((await coordinator().getRun(runId))?.run.status).toBe("failed");
    expect((await coordinator().status())["watermark"]).toBeNull();
    await instance.dispose();
  });

  it("retries a failing commit step (mocked step error)", async () => {
    const runId = await coordinator().nextRunId();
    const instance = await introspectWorkflowInstance(env.WAREHOUSE_RUN, runId);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "commit" }, new Error("transient commit failure"), 2);
    });
    const runner = startRunner(happy);
    await coordinator().requestRun("test");
    await instance.waitForStatus("complete");
    await runner.stop();
    expect((await coordinator().getRun(runId))?.run.status).toBe("committed");
    await instance.dispose();
  });

  it("the commit_step_error eval fault throws once and the retried commit succeeds", async () => {
    await coordinator().installFaults([{ run_seq: 1, kind: "commit_step_error" }]);
    const runner = startRunner(happy);
    const { runId, instance } = await startRun();
    await instance.waitForStatus("complete");
    await runner.stop();
    expect((await coordinator().getRun(runId))?.run.status).toBe("committed");
    expect(await coordinator().consumeCommitFault(runId)).toBe(false);
    await instance.dispose();
  });

  it("skips the transform when nothing new was loaded and keeps the previous digests", async () => {
    let first = true;
    const runner = startRunner(async (job) => {
      if (job.kind === "load" && !first) return loadOk(job, { rows: 0, rawMax: (await coordinator().getRun(job.run_id))?.run.load_seq ? job.load_seq - 1 : null, to: null });
      return happy(job);
    });
    const one = await startRun();
    await one.instance.waitForStatus("complete");
    first = false;
    const two = await startRun();
    await two.instance.waitForStatus("complete");
    const claimed = await runner.stop();
    expect(claimed.map((j) => j.kind)).toEqual(["load", "transform", "load"]);
    expect(await two.instance.getOutput()).toMatchObject({ transform_skipped: true, transform_attempts: 0 });
    const run2 = (await coordinator().getRun(two.runId))?.run;
    const run1 = (await coordinator().getRun(one.runId))?.run;
    expect(run2?.transform_skipped).toBe(1);
    expect(run2?.digests_json).toBe(run1?.digests_json);
    expect(run2?.to_snapshot).toBe(run1?.to_snapshot);
    await one.instance.dispose();
    await two.instance.dispose();
  });

  it("does not skip the transform when raw data is newer than the last transform", async () => {
    let run1Load = 0;
    const runner = startRunner(async (job) => {
      if (job.kind === "load") {
        if (run1Load === 0) {
          run1Load = job.load_seq;
          return loadOk(job);
        }
        return loadOk(job, { rows: 0, rawMax: run1Load, to: null });
      }
      return job.run_id.endsWith("000001") ? failed(job) : transformOk(job);
    });
    const one = await startRun();
    await one.instance.waitForStatus("errored");
    const two = await startRun();
    await two.instance.waitForStatus("complete");
    await runner.stop();
    expect(await two.instance.getOutput()).toMatchObject({ transform_skipped: false, transform_attempts: 1 });
    await one.instance.dispose();
    await two.instance.dispose();
  });

  it("a scratch point-in-time replay passes its options to both jobs and never moves the watermark", async () => {
    const seen: Record<string, unknown>[] = [];
    const runner = startRunner(async (job) => {
      seen.push({ kind: job.kind, input: job.input, mode: job.mode });
      return happy(job);
    });
    const one = await startRun();
    await one.instance.waitForStatus("complete");
    const watermark = (await coordinator().status())["watermark"];
    const runId = await coordinator().nextRunId();
    const instance = await introspectWorkflowInstance(env.WAREHOUSE_RUN, runId);
    await coordinator().requestRun("replay-scratch", "replay", Date.now(), { to_snapshot: "123", dataset_suffix: "pit" });
    await instance.waitForStatus("complete");
    await runner.stop();
    const landing_prefix = `landing/raw_events/g${await coordinator().generation()}/`;
    expect(seen.slice(2)).toEqual([
      { kind: "load", mode: "replay", input: { from_snapshot: null, full_refresh: false, landing_prefix, to_snapshot: "123", dataset_suffix: "pit" } },
      { kind: "transform", mode: "replay", input: { from_snapshot: null, full_refresh: true, to_snapshot: "123", dataset_suffix: "pit" } },
    ]);
    expect((await coordinator().status())["watermark"]).toBe(watermark);
    const scratch = await coordinator().getRun(runId);
    expect(scratch?.run.status).toBe("committed");
    expect(scratch?.run.digests_json).not.toBeNull();
    await one.instance.dispose();
    await instance.dispose();
  });

  it("transform skip rule", () => {
    const plan = { mode: "incremental" as const, transformed_through_seq: 100 };
    expect(shouldSkipTransform(plan, { rows_inserted: 0, raw_max_load_seq: 100 })).toBe(true);
    expect(shouldSkipTransform(plan, { rows_inserted: 0, raw_max_load_seq: 101 })).toBe(false);
    expect(shouldSkipTransform(plan, { rows_inserted: 5, raw_max_load_seq: 100 })).toBe(false);
    expect(shouldSkipTransform({ ...plan, mode: "replay" }, { rows_inserted: 0, raw_max_load_seq: 100 })).toBe(false);
    expect(shouldSkipTransform({ mode: "incremental", transformed_through_seq: null }, { rows_inserted: 0, raw_max_load_seq: null })).toBe(true);
  });
});
