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
