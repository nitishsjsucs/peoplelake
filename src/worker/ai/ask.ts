// POST /api/ask {question}: question -> validated MetricQuery -> answer from the committed metrics
// snapshot (reports/metrics/latest.json). The model only chooses the query; every number comes from
// the snapshot that the last committed run published.
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { LATEST_METRICS_KEY } from "../reports.ts";
import type { AppConfig } from "../config.ts";
import { type AiProvider, AskError, type MetricQuery, makeProvider } from "./providers.ts";

interface SnapshotRow {
  month: string;
  department_id: string;
  [metric: string]: string | null;
}

// The Workers AI model id; llama-server serves whatever GGUF it was started with (the eval records it).
function modelOf(config: AppConfig, provider: AiProvider["name"]): string | null {
  return provider === "workers-ai" ? (config.ai.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast") : null;
}

export function answer(query: MetricQuery, rows: SnapshotRow[]): { month: string; value: string | null }[] {
  return rows
    .filter((r) => r.department_id === query.department_id)
    .filter((r) => r.month.slice(0, 7) >= query.start_month && r.month.slice(0, 7) <= query.end_month)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => ({ month: r.month.slice(0, 7), value: r[query.metric] ?? null }));
}

async function questionOf(req: Request): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  return question && question.length <= 500 ? question : null;
}

export function mountAsk(app: App): void {
  // Translation only (question -> MetricQuery), no snapshot needed: what `peoplelake eval ask` scores,
  // through the same provider code path that /api/ask uses.
  app.post("/api/ask/query", requireRole("viewer", "operator"), async (c) => {
    const question = await questionOf(c.req.raw);
    if (question === null) return c.json({ error: "question must be 1 to 500 characters" }, 400);
    const config = c.get("config");
    try {
      const provider = makeProvider(config, c.env);
      const query = await provider.toQuery(question);
      return c.json({ provider: provider.name, model: modelOf(config, provider.name), query });
    } catch (err) {
      if (err instanceof AskError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post("/api/ask", requireRole("viewer", "operator"), async (c) => {
    const question = await questionOf(c.req.raw);
    if (question === null) return c.json({ error: "question must be 1 to 500 characters" }, 400);
    const snapshot = await c.env.REPORTS_BUCKET.get(LATEST_METRICS_KEY);
    if (snapshot === null) return c.json({ error: "no_committed_metrics" }, 404);
    const metrics = (await snapshot.json()) as { run_id: string; rows: SnapshotRow[] };
    try {
      const provider = makeProvider(c.get("config"), c.env);
      const query = await provider.toQuery(question);
      return c.json({
        provider: provider.name,
        provider_note: provider.name === "stub" ? "deterministic rule parser (no model)" : null,
        query,
        source: { key: LATEST_METRICS_KEY, run_id: metrics.run_id },
        values: answer(query, metrics.rows),
      });
    } catch (err) {
      if (err instanceof AskError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
