// Operator checks used by `npm run doctor` (SPEC 7.3).
import type { AiBinding } from "../ai/providers.ts";
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { makeDispatcher } from "../orchestration/dispatcher.ts";
import { accessToken, parseServiceAccountKey, type TokenCache } from "../orchestration/gcp-token.ts";

export function mountOpsApi(app: App): void {
  app.get("/api/ops/lake", requireRole("operator"), async (c) => {
    const status = await coordinatorStub(c.env).status();
    const config = c.get("config");
    return c.json({
      lake_mode: config.lakeMode,
      stand_in: config.lakeMode === "local" ? "SinkRoller Durable Object and pyiceberg SqlCatalog" : null,
      watermark: status["watermark"],
      transformed_through_seq: status["transformed_through_seq"],
      last_lake_event_at: status["last_lake_event_at"],
      catalog_last_poll: status["catalog_last_poll"],
      malformed_lake_events: status["malformed_lake_events"],
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
    try {
      await ai.run(
        config.ai.model ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 4 },
        { gateway: { id: config.ai.gatewayId ?? "peoplelake" } },
      );
      return c.json({ ok: true, gateway_log_id_present: Boolean(ai.aiGatewayLogId) });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
}
