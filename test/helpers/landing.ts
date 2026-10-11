import { env, runInDurableObject } from "cloudflare:test";
import type { RawRecord } from "../../src/shared/contracts.ts";
import { LANDING_PREFIX, type LandingRoller, landingRollerStub } from "../../src/worker/lake/landing-roller.ts";

export function rollerStub(): DurableObjectStub<LandingRoller> {
  return landingRollerStub(env);
}

/** Buffered rows (one per ingest request) as the records they hold. */
export async function bufferedRows(): Promise<RawRecord[][]> {
  return runInDurableObject(rollerStub(), async (_instance: LandingRoller, state) =>
    state.storage.sql
      .exec<{ ndjson: string }>("SELECT ndjson FROM buffer ORDER BY seq")
      .toArray()
      .map((r) => r.ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l) as RawRecord)),
  );
}

export async function bufferedRecords(): Promise<RawRecord[]> {
  return (await bufferedRows()).flat();
}

export async function rollFiles(): Promise<{ key: string; body: string; lines: string[]; etag: string }[]> {
  const listed = await env.LAKE_BUCKET.list({ prefix: LANDING_PREFIX });
  const out = [];
  for (const o of listed.objects) {
    const body = (await (await env.LAKE_BUCKET.get(o.key))?.text()) ?? "";
    out.push({ key: o.key, etag: o.etag, body, lines: body.split("\n").filter(Boolean) });
  }
  return out;
}
