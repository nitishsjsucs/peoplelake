// Runner interface (SPEC 7.3): claim, heartbeat, result, metrics artifact. Runner role only.
import { LoadResult, TransformResult } from "../../shared/contracts.ts";
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { sha256Hex } from "../ingest/canonical-json.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { metricsKey } from "../reports.ts";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export function mountInternalApi(app: App): void {
  app.post("/internal/jobs/claim", requireRole("runner"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { worker_id?: unknown };
    const workerId = typeof body.worker_id === "string" && body.worker_id ? body.worker_id : c.get("principal").id;
    const spec = await coordinatorStub(c.env).claimJob(workerId);
    if (spec === null) return c.body(null, 204);
    return c.json(spec);
  });

  app.post("/internal/jobs/:job_id/heartbeat", requireRole("runner"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { worker_id?: unknown };
    const workerId = typeof body.worker_id === "string" && body.worker_id ? body.worker_id : c.get("principal").id;
    const res = await coordinatorStub(c.env).heartbeat(c.req.param("job_id"), workerId);
    if (!res.ok) return c.json({ error: "not_lease_holder" }, 409);
    return c.json(res);
  });

  app.post("/internal/jobs/:job_id/result", requireRole("runner"), async (c) => {
    const coordinator = coordinatorStub(c.env);
    const jobId = c.req.param("job_id");
    const job = await coordinator.jobStatus(jobId);
    if (job === null) return c.json({ error: "unknown_job" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = (job.kind === "load" ? LoadResult : TransformResult).safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_result", issues: parsed.error.issues.slice(0, 20) }, 422);
    const result = parsed.data as Record<string, unknown>;
    if (result["job_id"] !== jobId || result["attempt"] !== job.attempt || result["run_id"] !== job.run_id) {
      return c.json({ error: "result_does_not_match_job" }, 422);
    }
    const res = await coordinator.completeJob(jobId, result);
    return c.json({ duplicate: res.duplicate });
  });

  app.put("/internal/runs/:run_id/artifacts/metrics", requireRole("runner"), async (c) => {
    const runId = c.req.param("run_id");
    const expected = c.req.query("sha256") ?? "";
    const body = await c.req.text();
    if (body.length > MAX_ARTIFACT_BYTES) return c.json({ error: "payload_too_large" }, 413);
    const sha = await sha256Hex(body);
    if (!/^[0-9a-f]{64}$/.test(expected) || sha !== expected) return c.json({ error: "sha256_mismatch", sha256: sha }, 422);
    if ((await coordinatorStub(c.env).getRun(runId)) === null) return c.json({ error: "unknown_run" }, 404);
    const key = metricsKey(runId);
    await c.env.REPORTS_BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: sha } });
    return c.json({ key, sha256: sha, bytes: body.length });
  });
}
