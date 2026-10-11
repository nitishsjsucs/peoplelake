import { env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { loadOk } from "../helpers/runner.ts";
import { call } from "../helpers/tokens.ts";

beforeEach(async () => {
  await coordinatorStub(env).setTestOptions({ startWorkflows: false });
});

afterEach(async () => {
  await reset();
});

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("API role gates", () => {
  it("lets viewers and the runner read runs but only operators start them", async () => {
    expect((await call("/api/runs", "viewer")).status).toBe(200);
    expect((await call("/api/runs", "runner")).status).toBe(200);
    expect((await call("/api/runs", "hris")).status).toBe(403);
    expect((await call("/api/runs", "viewer", { method: "POST" })).status).toBe(403);
    const started = await call("/api/runs", "operator", { method: "POST" });
    expect(started.status).toBe(202);
    const { run_id } = (await started.json()) as { run_id: string };
    const list = (await (await call("/api/runs?format=full", "viewer")).json()) as { runs: { run_id: string; load_seq: number }[] };
    expect(list.runs[0]?.run_id).toBe(run_id);
    expect(list.runs[0]?.load_seq).toBeGreaterThan(0);
    expect((await call(`/api/runs/${run_id}`, "viewer")).status).toBe(200);
    expect((await call("/api/runs/r-nope-000001", "viewer")).status).toBe(404);
    expect((await call("/api/replay", "operator", { method: "POST" })).status).toBe(202);
  });

  it("keeps ops routes operator-only and reports poll mode locally", async () => {
    expect((await call("/api/ops/lake", "viewer")).status).toBe(403);
    expect((await call("/api/ops/dispatch", "runner")).status).toBe(403);
    expect(await (await call("/api/ops/dispatch", "operator")).json()).toMatchObject({ ok: false, mode: "poll" });
    expect(await (await call("/api/ops/lake", "operator")).json()).toMatchObject({ lake_mode: "local", watermark: null });
  });

  it("pages /api/runs at most 200 at a time, newest first, or forward from since", async () => {
    const c = coordinatorStub(env);
    const t0 = Date.parse("2026-10-01T00:00:00.000Z");
    for (let i = 0; i < 205; i++) {
      const res = await c.requestRun("manual", "incremental", t0 + i * 1000);
      await c.failRun(res.run_id ?? "", "x", t0 + i * 1000 + 1);
      await c.releaseRun(res.run_id ?? "", t0 + i * 1000 + 1);
    }
    const newest = (await (await call("/api/runs?limit=1000&format=full", "viewer")).json()) as { runs: { seq: number }[]; max_per_page: number };
    expect(newest.max_per_page).toBe(200);
    expect(newest.runs).toHaveLength(200);
    expect(newest.runs[0]?.seq).toBe(205);
    const page = (await (await call(`/api/runs?limit=200&since=${t0 + 200_000}`, "viewer")).json()) as { runs: { seq: number }[] };
    expect(page.runs.map((r) => r.seq)).toEqual([201, 202, 203, 204, 205]);
    expect((await call("/api/runs?since=yesterday", "viewer")).status).toBe(400);
  });

  it("reports the Free plan budget state to operators only", async () => {
    expect((await call("/api/ops/budget", "viewer")).status).toBe(403);
    expect((await call("/api/ops/budget", "runner")).status).toBe(403);
    const res = await call("/api/ops/budget", "operator");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(Object.keys(body.runs)).toEqual(
      expect.arrayContaining(["automatic_today", "automatic_max_per_day", "consecutive_failures", "failure_backoff_until", "workflow_steps_today"]),
    );
    expect(body.bigquery).toMatchObject({ ok: true, cap_bytes: 275_000_000_000, reserve_bytes: 3_000_000_000 });
    expect(body.durable_objects.rows_read_today).toBeGreaterThan(0);
  });

  it("takes the measured BigQuery month total from operators only", async () => {
    const month = new Date().toISOString().slice(0, 7);
    expect((await call("/api/ops/bq-month", "runner", json({ month, bytes_billed: 1 }))).status).toBe(403);
    expect((await call("/api/ops/bq-month", "operator", json({ month: "October", bytes_billed: 1 }))).status).toBe(400);
    expect((await call("/api/ops/bq-month", "operator", json({ month, bytes_billed: -1 }))).status).toBe(400);
    const res = await call("/api/ops/bq-month", "operator", json({ month, bytes_billed: 274_000_000_000 }));
    expect(await res.json()).toMatchObject({ ok: false, bytes_billed: 274_000_000_000 });
  });

  it("serves the committed metrics snapshot and 404 before any commit", async () => {
    expect((await call("/api/metrics/latest", "viewer")).status).toBe(404);
    await env.REPORTS_BUCKET.put("reports/metrics/latest.json", JSON.stringify({ rows: [] }));
    expect(await (await call("/api/metrics/latest", "viewer")).json()).toEqual({ rows: [] });
    expect((await call("/api/metrics/latest", "runner")).status).toBe(403);
  });

  it("only operators may install eval faults, and only valid ones", async () => {
    expect((await call("/internal/dev/faults", "runner", json({ faults: [] }))).status).toBe(403);
    expect((await call("/internal/dev/faults", "operator", json({ faults: [{ run_seq: 1, kind: "nope" }] }))).status).toBe(422);
    const ok = await call("/internal/dev/faults", "operator", json({ faults: [{ run_seq: 2, kind: "skip_claim" }] }));
    expect(await ok.json()).toEqual({ installed: 1 });
  });
});

describe("runner interface", () => {
  it("claims, heartbeats and reports a validated result; a second report is a duplicate", async () => {
    const coordinator = coordinatorStub(env);
    const { run_id } = await coordinator.requestRun("test");
    const spec = await coordinator.enqueueJob(run_id ?? "", "load", 1, { from_snapshot: null, full_refresh: false });
    expect((await call("/internal/jobs/claim", "viewer", json({ worker_id: "w" }))).status).toBe(403);
    const claimed = await call("/internal/jobs/claim", "runner", json({ worker_id: "w" }));
    expect(await claimed.json()).toMatchObject({ job_id: spec.job_id });
    expect((await call("/internal/jobs/claim", "runner", json({ worker_id: "w" }))).status).toBe(204);
    expect((await call(`/internal/jobs/${spec.job_id}/heartbeat`, "runner", json({ worker_id: "other" }))).status).toBe(409);
    expect((await call(`/internal/jobs/${spec.job_id}/heartbeat`, "runner", json({ worker_id: "w" }))).status).toBe(200);
    const invalid = await call(`/internal/jobs/${spec.job_id}/result`, "runner", json({ status: "succeeded" }));
    expect(invalid.status).toBe(422);
    const wrongJob = await call(`/internal/jobs/${spec.job_id}/result`, "runner", json({ ...loadOk(spec), attempt: 2 }));
    expect(wrongJob.status).toBe(422);
    const ok = await call(`/internal/jobs/${spec.job_id}/result`, "runner", json(loadOk(spec)));
    expect(await ok.json()).toEqual({ duplicate: false });
    const again = await call(`/internal/jobs/${spec.job_id}/result`, "runner", json(loadOk(spec)));
    expect(await again.json()).toEqual({ duplicate: true });
    expect((await call("/internal/jobs/unknown/result", "runner", json(loadOk(spec)))).status).toBe(404);
  });

  it("answers a runner at its idle exit: exit when nothing is queued (runner role only)", async () => {
    expect((await call("/internal/runner/idle", "operator", json({ worker_id: "w" }))).status).toBe(403);
    expect(await (await call("/internal/runner/idle", "runner", json({ worker_id: "w" }))).json()).toEqual({ exit: true });
    const coordinator = coordinatorStub(env);
    const { run_id } = await coordinator.requestRun("test");
    await coordinator.enqueueJob(run_id ?? "", "load", 1, { from_snapshot: null, full_refresh: false });
    expect(await (await call("/internal/runner/idle", "runner", json({ worker_id: "w" }))).json()).toEqual({ exit: false });
  });

  it("stores the metrics artifact only when its sha256 matches", async () => {
    const { run_id } = await coordinatorStub(env).requestRun("test");
    const body = '{"rows":[]}';
    const put = (sha: string) => call(`/internal/runs/${run_id}/artifacts/metrics?sha256=${sha}`, "runner", { method: "PUT", body });
    expect((await put("0".repeat(64))).status).toBe(422);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ok = await put(sha);
    expect(await ok.json()).toEqual({ key: `reports/metrics/${run_id}.json`, sha256: sha, bytes: body.length });
    expect(await (await env.REPORTS_BUCKET.get(`reports/metrics/${run_id}.json`))?.text()).toBe(body);
  });
});

describe("operator reset", () => {
  it("needs the confirmation, refuses during a run and starts a new generation", async () => {
    const coordinator = coordinatorStub(env);
    const before = await coordinator.generation();
    const { run_id } = await coordinator.requestRun("test");
    expect((await call("/api/ops/reset", "operator", json({}))).status).toBe(400);
    expect((await call("/api/ops/reset", "viewer", json({ confirm: "peoplelake" }))).status).toBe(403);
    expect((await call("/api/ops/reset", "operator", json({ confirm: "peoplelake" }))).status).toBe(409);
    await coordinator.failRun(run_id ?? "", "x");
    await coordinator.releaseRun(run_id ?? "");
    const res = await call("/api/ops/reset", "operator", json({ confirm: "peoplelake" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generation: number };
    expect(body.generation).toBeGreaterThan(before);
    expect(await coordinator.listRuns()).toEqual([]);
    await coordinator.setTestOptions({ startWorkflows: false });
    const next = await coordinator.requestRun("after reset");
    expect(next.run_id).toMatch(new RegExp(`^r-${body.generation.toString(36)}-000001$`));
  });
});

