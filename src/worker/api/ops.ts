// Operator checks used by `npm run doctor` (SPEC 7.3). The doctor's default probes have no side effects:
// `/api/ops/ai` and `/api/ops/dispatch` only check configuration unless asked for a live call.
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

  // Default: the dispatcher key parses and names a service account (no side effects). `?token=1` also mints
  // an access token (an OAuth exchange, cached in the Coordinator); `?execute=1` starts one runner execution.
  app.get("/api/ops/dispatch", requireRole("operator"), async (c) => {
    const config = c.get("config");
    if (config.runnerDispatch !== "cloudrun") return c.json({ ok: false, mode: "poll", reason: "RUNNER_DISPATCH=poll (local runner)" });
    const coordinator = coordinatorStub(c.env);
    const tokens: TokenCache = { get: () => coordinator.getGcpToken(), set: (t) => coordinator.setGcpToken(t) };
    try {
      const raw = (c.env as unknown as Record<string, unknown>)["GCP_DISPATCHER_KEY"];
      const key = parseServiceAccountKey(String(raw ?? ""));
      if (c.req.query("token") !== "1" && c.req.query("execute") !== "1") {
        return c.json({ ok: true, check: "key", client_email: key.client_email, job: config.gcp?.job ?? null });
      }
      const token = await accessToken(key, tokens);
      const out: Record<string, unknown> = { ok: true, expires_in: Math.round((token.expires_at - Date.now()) / 1000), cached: token.cached };
      if (c.req.query("execute") === "1") out["execution"] = await makeDispatcher(config, c.env, tokens).dispatch();
      return c.json(out);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Default: the binding, model, gateway and limits are configured (no model call). `?live=1` makes one tiny
  // Workers AI call through AI Gateway (about 3 neurons of the shared daily allowance, one gateway log
  // entry); the gateway log id proves the call went through the gateway.
  app.get("/api/ops/ai", requireRole("operator"), async (c) => {
    const config = c.get("config");
    const ai = (c.env as unknown as { AI?: AiBinding }).AI;
    if (config.ai.provider !== "workers-ai" || !ai) {
      return c.json({ ok: false, provider: config.ai.provider, reason: "no Workers AI binding here (local: llama-server or the stub)" });
    }
    const model = config.ai.model ?? AI_MODEL;
    if (c.req.query("live") !== "1") {
      return c.json({
        ok: typeof ai.run === "function" && Boolean(config.ai.gatewayId),
        check: "binding",
        model,
        gateway_id: config.ai.gatewayId,
        max_tokens: config.ai.maxTokens,
        daily_neuron_cap: config.ai.dailyNeuronCap,
      });
    }
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
  // The month's BigQuery bytes measured from INFORMATION_SCHEMA by the operator's tools (the BigQuery drill,
  // `peoplelake prod bq-month`): a floor for the monthly guard, which otherwise sees only runner results.
  app.post("/api/ops/bq-month", requireRole("operator"), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { month?: unknown; bytes_billed?: unknown };
    const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;
    const bytes = typeof body.bytes_billed === "number" && Number.isSafeInteger(body.bytes_billed) && body.bytes_billed >= 0 ? body.bytes_billed : null;
    if (month === null || bytes === null) return c.json({ error: "month (YYYY-MM) and bytes_billed (integer) required" }, 400);
    return c.json(await coordinatorStub(c.env).noteBqMonth(month, bytes));
  });

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
