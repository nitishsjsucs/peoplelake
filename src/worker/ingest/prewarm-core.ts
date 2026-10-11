// The startup prewarm itself (SPEC 29.4.2), separate from the fixture imports so `npm run bench:ingest`
// can run the same function in Node, where JSON imports need import attributes the Worker build does not
// use. Everything here is synchronous and uses no randomness, so it may run at module scope in workerd.
import { AtsBatch, HrisBatch, RawRecord, TalentBatch } from "../../shared/contracts.ts";
import { normalizeBatch, toNdjson } from "./normalize.ts";

export interface PrewarmInput {
  hris: { events: unknown[] };
  ats: { records: unknown[] };
  talent: { items: unknown[] };
  rawRecord: unknown;
}

export interface PrewarmReport {
  hris: string[];
  ats: string[];
  talent: string[];
  raw_record: boolean;
  normalized: number;
}

const PREWARM_CONTEXT = {
  receivedAt: "2026-01-01T00:00:00.000Z",
  requestId: "prewarm",
  producer: "peoplelake-ingest/prewarm",
  newDeliveryId: () => "00000000-0000-4000-8000-000000000000",
};

/** Parse every envelope on its own with its batch schema, normalize all of them, validate the RawRecords
 * and serialize them as NDJSON: the whole ingest code path, once, before the first request. */
export function prewarmSchemas(input: PrewarmInput): PrewarmReport {
  const hris = HrisBatch.parse(input.hris).events;
  const ats = AtsBatch.parse(input.ats).records;
  const talent = TalentBatch.parse(input.talent).items;
  for (const e of hris) HrisBatch.parse({ events: [e] });
  for (const r of ats) AtsBatch.parse({ records: [r] });
  for (const i of talent) TalentBatch.parse({ items: [i] });
  RawRecord.parse(input.rawRecord);
  const records = [
    ...normalizeBatch("hris", hris, PREWARM_CONTEXT),
    ...normalizeBatch("ats", ats, PREWARM_CONTEXT),
    ...normalizeBatch("talent", talent, PREWARM_CONTEXT),
  ];
  for (const r of records) RawRecord.parse(r);
  toNdjson(records);
  return { hris: hris.map((e) => e.eventType), ats: ats.map((r) => r.type), talent: talent.map((i) => i.kind), raw_record: true, normalized: records.length };
}
