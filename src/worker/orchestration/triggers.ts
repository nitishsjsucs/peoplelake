// Every minute (SPEC 7.6): sweeps and the local trigger and heartbeat (Coordinator.tick), then in
// production the Basin Catalog poll for new append snapshots. Nothing runs on a config error.
import { ConfigError, parseConfig } from "../config.ts";
import { pollCatalog } from "../lake/catalog-poll.ts";
import { coordinatorStub } from "./coordinator.ts";

export async function runScheduled(env: Env, now: number = Date.now(), fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  let config;
  try {
    config = parseConfig(env as unknown as Record<string, unknown>, null);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`peoplelake scheduled skipped: config error: ${err.message}`);
      return { skipped: "config" };
    }
    throw err;
  }
  const coordinator = coordinatorStub(env);
  const tick = await coordinator.tick(now);
  let poll = null;
  const token = (env as unknown as Record<string, unknown>)["R2_CATALOG_TOKEN"];
  if (config.runsEnabled && config.lakeMode === "basin" && config.basin && typeof token === "string" && token) {
    const status = await coordinator.status();
    poll = await pollCatalog({
      catalogUri: config.basin.catalogUri,
      prefix: config.basin.catalogPrefix,
      token,
      watermark: (status["watermark"] as string | null) ?? null,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      now: new Date(now),
    });
    await coordinator.recordCatalogPoll(poll as unknown as Record<string, unknown>);
    if (poll.new_data) await coordinator.requestRun("catalog");
  }
  return { tick, poll };
}
