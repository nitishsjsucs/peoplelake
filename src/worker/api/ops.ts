// Operator checks used by `npm run doctor` (SPEC 7.3).
import { AI_MODEL, aiReservation } from "../../shared/free-budget.ts";
import type { AiBinding } from "../ai/providers.ts";
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { landingRollerStub } from "../lake/landing-roller.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { makeDispatcher } from "../orchestration/dispatcher.ts";
import { accessToken, parseServiceAccountKey, type TokenCache } from "../orchestration/gcp-token.ts";

export function mountOpsApi(app: App): void {
  app.get("/api/ops/lake", requireRole("operator"), async (c) => {
    const status = await coordinatorStub(c.env).status();
    const config = c.get("config");
    const landing = await landingRollerStub(c.env).status();
    return c.json({
      lake_mode: config.lakeMode,
      // The landing (LandingRoller, R2, Queue) is the same code everywhere; only the catalog is a stand-in locally.
      stand_in: config.lakeMode === "local" ? "pyiceberg SqlCatalog (local catalog stand-in for Basin Catalog)" : null,
      landing: {
        buffered_requests: landing.buffered_requests,
        buffered_bytes: landing.buffered_bytes,
        next_roll_seq: landing.next_roll_seq,
        pending_roll: landing.pending_roll,
        landed_through: status["landed_through"],
        landed_rolls: status["landed_rolls"],
        landed_records: status["landed_records"],
        last_roll: status["last_roll"],
      },
      watermark: status["watermark"],
      transformed_through_seq: status["transformed_through_seq"],
      last_lake_event_at: status["last_lake_event_at"],
      malformed_lake_events: status["malformed_lake_events"],
    });
  });

  // Free plan budget state (SPEC 29.4.3): this repo's Durable Object rows read and written today, run
  // guards, Workflow steps today and BigQuery bytes this month. `npm run doctor` prints it.
  app.get("/api/ops/budget", requireRole("operator"), async (c) => {
    const coordinator = await coordinatorStub(c.env).budget();
    const landing = await landingRollerStub(c.env).sqlUsage();
    return c.json({
      ...coordinator,
      durable_objects: {
        rows_read_today: coordinator.sql.rows_read + landing.rows_read,
        rows_written_today: coordinator.sql.rows_written + landing.rows_written,
        coordinator: coordinator.sql,
        landing_roller: landing,
      },
    });
  });

  app.get("/api/ops/dispatch", requireRole("operator"), async (c) => {
    const config = c.get("config");
    if (config.runnerDispatch !== "cloudrun") return c.json({ ok: false, mode: "poll", reason: "RUNNER_DISPATCH=poll (local runner)" });
    const coordinator = coordinatorStub(c.env);
    const tokens: TokenCache = { get: () => coordinator.getGcpToken(), set: (t) => coordinator.setGcpToken(t) };
    try {
      const raw = (c.env as unknown as Record<string, unknown>)["GCP_DISPATCHER_KEY"];
      const token = await accessToken(parseServiceAccountKey(String(raw ?? "")), tokens);
      const out: Record<string, unknown> = { ok: true, expires_in: Math.round((token.expires_at - Date.now()) / 1000), cached: token.cached };
      if (c.req.query("execute") === "1") out["execution"] = await makeDispatcher(config, c.env, tokens).dispatch();
      return c.json(out);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // One tiny Workers AI call through AI Gateway; the gateway log id proves the call went through the gateway.
  app.get("/api/ops/ai", requireRole("operator"), async (c) => {
    const config = c.get("config");
    const ai = (c.env as unknown as { AI?: AiBinding }).AI;
    if (config.ai.provider !== "workers-ai" || !ai) {
      return c.json({ ok: false, provider: config.ai.provider, reason: "no Workers AI binding here (local: llama-server or the stub)" });
    }
    const model = config.ai.model ?? AI_MODEL;
    const content = "Reply with the word ok.";
    const reserved = await coordinatorStub(c.env).reserveNeurons(aiReservation(model, content.length, 4));
    if (!reserved.ok) return c.json({ ok: false, error: "ai_budget", used: reserved.used, cap: reserved.cap }, 429);
    try {
      await ai.run(model, { messages: [{ role: "user", content }], max_tokens: 4 }, { gateway: { id: config.ai.gatewayId ?? "peoplelake" } });
      return c.json({ ok: true, gateway_log_id_present: Boolean(ai.aiGatewayLogId) });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Guarded ledger reset before a second prod:e2e (runbook prod-reset.md).
  app.post("/api/ops/reset", requireRole("operator"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
    if (body.confirm !== "peoplelake") return c.json({ error: "confirm must be peoplelake" }, 400);
    try {
      return c.json(await coordinatorStub(c.env).resetAll("peoplelake"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });
}
