// Local-only routes (mounted only when ENVIRONMENT=local; 404 otherwise). They expose the SinkRoller
// stand-in's roll files to the Python committer and let the eval driver force a roll.
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { SINK_ROLLER_NAME } from "../lake/sink.ts";
import { SINK_PREFIX } from "../lake/sink-roller.ts";

const FILES = "/internal/dev/sink/files";

export function mountDevRoutes(app: App): void {
  app.get(FILES, requireRole("runner", "operator"), async (c) => {
    const bucket = c.env.LAKE_BUCKET;
    if (!bucket) return c.json({ error: "no_local_lake_bucket" }, 500);
    const after = c.req.query("after");
    const files: { key: string; etag: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix: SINK_PREFIX,
        ...(after ? { startAfter: after } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const o of page.objects) files.push({ key: o.key, etag: o.etag, size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return c.json({ files });
  });

  app.get(`${FILES}/*`, requireRole("runner", "operator"), async (c) => {
    const bucket = c.env.LAKE_BUCKET;
    if (!bucket) return c.json({ error: "no_local_lake_bucket" }, 500);
    const key = decodeURIComponent(c.req.path.slice(FILES.length + 1));
    if (!key.startsWith(SINK_PREFIX)) return c.json({ error: "not_found" }, 404);
    const obj = await bucket.get(key);
    if (obj === null) return c.json({ error: "not_found" }, 404);
    return new Response(obj.body, { headers: { "content-type": "application/x-ndjson", etag: obj.httpEtag } });
  });

  app.post("/internal/dev/sink/flush", requireRole("operator"), async (c) => {
    const roller = c.env.SINK_ROLLER.get(c.env.SINK_ROLLER.idFromName(SINK_ROLLER_NAME));
    const rolled = await roller.flush();
    return c.json({ rolled });
  });
}
