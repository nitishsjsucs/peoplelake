// PeopleLake Worker entry point: HTTP (Hono), the lake-events queue consumer and the per-minute cron.
import { mountAsk } from "./ai/ask.ts";
import { mountDevRoutes } from "./api/dev.ts";
import { mountInternalApi } from "./api/internal.ts";
import { mountOpsApi } from "./api/ops.ts";
import { mountPublicApi } from "./api/public.ts";
import { createApp } from "./app.ts";
import { mountIngest } from "./ingest/routes.ts";
import { handleLakeEvents } from "./lake/lake-events.ts";
import { coordinatorStub } from "./orchestration/coordinator.ts";
import { runScheduled } from "./orchestration/triggers.ts";

export { SinkRoller } from "./lake/sink-roller.ts";
export { Coordinator } from "./orchestration/coordinator.ts";
export { WarehouseRunWorkflow } from "./orchestration/warehouse-run.ts";

const app = createApp((a) => {
  mountIngest(a, { afterAccept: (env, accepted, receivedAt) => coordinatorStub(env).noteIngest(accepted, receivedAt) });
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
