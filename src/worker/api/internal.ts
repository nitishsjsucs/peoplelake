// Runner interface (SPEC 7.3, 29.4.1): claim, heartbeat, result, metrics artifact, and the landing roll
// files the runner's committer appends to the Iceberg table. Mounted in every environment.
import { LoadResult, TransformResult } from "../../shared/contracts.ts";
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { sha256Hex } from "../ingest/canonical-json.ts";
import { LANDING_PREFIX } from "../lake/landing-keys.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { metricsKey } from "../reports.ts";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const LAKE_FILES = "/internal/lake/files";
const MAX_FILES_PER_LIST = 1000;

export function mountInternalApi(app: App): void {
  // Landing rolls in key order after an optional cursor, under a prefix inside landing/raw_events/. Runner
  // only: the files carry unmasked compensation and performance payloads, and only the committer reads them.
  app.get(LAKE_FILES, requireRole("runner"), async (c) => {
    const prefix = c.req.query("prefix") ?? LANDING_PREFIX;
    if (!prefix.startsWith(LANDING_PREFIX)) return c.json({ error: "prefix_outside_landing" }, 400);
    const after = c.req.query("after");
    const files: { key: string; etag: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.LAKE_BUCKET.list({
        prefix,
        limit: MAX_FILES_PER_LIST - files.length,
        ...(after ? { startAfter: after } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const o of page.objects) files.push({ key: o.key, etag: o.etag, size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined && files.length < MAX_FILES_PER_LIST);
    // truncated: more rolls follow; the committer asks again with after=<last key>.
    return c.json({ prefix, files, truncated: cursor !== undefined });
  });

  app.get(`${LAKE_FILES}/*`, requireRole("runner"), async (c) => {
    const key = decodeURIComponent(c.req.path.slice(LAKE_FILES.length + 1));
    if (!key.startsWith(LANDING_PREFIX)) return c.json({ error: "not_found" }, 404);
    const obj = await c.env.LAKE_BUCKET.get(key);
    if (obj === null) return c.json({ error: "not_found" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/x-ndjson", etag: obj.httpEtag } });
  });

  app.post("/internal/jobs/claim", requireRole("runner"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { worker_id?: unknown };
    const workerId = typeof body.worker_id === "string" && body.worker_id ? body.worker_id : c.get("principal").id;
    const spec = await coordinatorStub(c.env).claimJob(workerId);
    if (spec === null) return c.body(null, 204);
    return c.json(spec);
  });

  // A runner idle for its whole --until-idle asks before exiting: stay when a job is queued, else exit.
  app.post("/internal/runner/idle", requireRole("runner"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { worker_id?: unknown };
    const workerId = typeof body.worker_id === "string" && body.worker_id ? body.worker_id : c.get("principal").id;
    return c.json(await coordinatorStub(c.env).runnerIdle(workerId));
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
