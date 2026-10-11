// Scheduled handler (SPEC 29.4.3): sweeps, the backstop that requests a run when a landing roll arrived
// after the last run started, and the heartbeat when enabled (Coordinator.tick). Nothing runs on a
// config error.
import { ConfigError, parseConfig } from "../config.ts";
import { coordinatorStub } from "./coordinator.ts";

export async function runScheduled(env: Env, now: number = Date.now()): Promise<Record<string, unknown>> {
  try {
    parseConfig(env as unknown as Record<string, unknown>, null);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`peoplelake scheduled skipped: config error: ${err.message}`);
      return { skipped: "config" };
    }
    throw err;
  }
  const tick = await coordinatorStub(env).tick(now);
  return { tick };
}
