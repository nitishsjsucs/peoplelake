// PeopleLake Worker entry point: HTTP (Hono), the lake-events queue consumer and the cron backstop.
import { mountAsk } from "./ai/ask.ts";
import { mountDevRoutes } from "./api/dev.ts";
import { mountInternalApi } from "./api/internal.ts";
import { mountOpsApi } from "./api/ops.ts";
import { mountPublicApi } from "./api/public.ts";
import { createApp } from "./app.ts";
import "./ingest/prewarm.ts"; // module scope: zod setup runs at isolate startup, not in the first request
import { mountIngest } from "./ingest/routes.ts";
import { handleLakeEvents } from "./lake/lake-events.ts";
import { runScheduled } from "./orchestration/triggers.ts";

export { LandingRoller } from "./lake/landing-roller.ts";
export { Coordinator } from "./orchestration/coordinator.ts";
export { WarehouseRunWorkflow } from "./orchestration/warehouse-run.ts";

const app = createApp((a) => {
  mountIngest(a);
  mountPublicApi(a);
  mountAsk(a);
  mountInternalApi(a);
  mountOpsApi(a);
  mountDevRoutes(a);
});

export default {
  fetch: app.fetch,
  async queue(batch, env): Promise<void> {
    await handleLakeEvents(batch, env);
  },
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
