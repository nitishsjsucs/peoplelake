// PeopleLake Worker entry point.
import { mountDevRoutes } from "./api/dev.ts";
import { createApp } from "./app.ts";
import { mountIngest } from "./ingest/routes.ts";

export { SinkRoller } from "./lake/sink-roller.ts";

const app = createApp((a) => {
  mountIngest(a);
  mountDevRoutes(a);
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
