import { env, runInDurableObject } from "cloudflare:test";
import type { RawRecord } from "../../src/shared/contracts.ts";
import { SINK_ROLLER_NAME } from "../../src/worker/lake/sink.ts";
import { SINK_PREFIX, type SinkRoller } from "../../src/worker/lake/sink-roller.ts";

export function rollerStub(): DurableObjectStub<SinkRoller> {
  return env.SINK_ROLLER.get(env.SINK_ROLLER.idFromName(SINK_ROLLER_NAME));
}

export async function bufferedRecords(): Promise<RawRecord[]> {
  return runInDurableObject(rollerStub(), async (_instance: SinkRoller, state) =>
    state.storage.sql
      .exec<{ record_json: string }>("SELECT record_json FROM buffer ORDER BY seq")
      .toArray()
      .map((r) => JSON.parse(r.record_json) as RawRecord),
  );
}

export async function rollFiles(): Promise<{ key: string; lines: string[]; etag: string }[]> {
  const bucket = env.LAKE_BUCKET;
  if (!bucket) throw new Error("no LAKE_BUCKET");
  const listed = await bucket.list({ prefix: SINK_PREFIX });
  const out = [];
  for (const o of listed.objects) {
    const body = await (await bucket.get(o.key))?.text();
    out.push({ key: o.key, etag: o.etag, lines: (body ?? "").split("\n").filter(Boolean) });
  }
  return out;
}
