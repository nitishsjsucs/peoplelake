// Envelope to RawRecord (SPEC 6.1). The payload is canonical JSON (integers only) and payload_sha256 is
// its sha256. delivery_id is minted per record per request, so a client retry is a new delivery of the
// same event (ADR 0001). pipeline/src/peoplelake/normalize.py mirrors this; contracts/golden/raw-records.json
// pins both.
import { type AtsRecord, type HrisEvent, RAW_RECORD_COLUMNS, type RawRecord, type TalentItem } from "../../shared/contracts.ts";
import type { SourceId } from "../../shared/sources.ts";
import { canonicalJson, sha256HexSync } from "./canonical-json.ts";

export interface DeliveryContext {
  readonly receivedAt: string;
  readonly requestId: string;
  readonly producer: string;
  readonly newDeliveryId?: () => string;
}

type Envelope = HrisEvent | AtsRecord | TalentItem;

interface EnvelopeView {
  event_id: string;
  event_type: string;
  entity_id: string;
  source_sequence: number;
  source_updated_at: string;
  effective_date: string;
  schema_version: number;
  payload: unknown;
}

export function viewEnvelope(source: SourceId, item: Envelope): EnvelopeView {
  switch (source) {
    case "hris": {
      const e = item as HrisEvent;
      return {
        event_id: e.eventId,
        event_type: e.eventType,
        entity_id: e.workerId,
        source_sequence: e.sequence,
        source_updated_at: e.recordedAt,
        effective_date: e.effectiveDate,
        schema_version: e.schemaVersion,
        payload: e.data,
      };
    }
    case "ats": {
      const e = item as AtsRecord;
      return {
        event_id: e.id,
        event_type: e.type,
        entity_id: e.object.id,
        source_sequence: e.seq,
        source_updated_at: e.occurred_at,
        effective_date: e.effective_on,
        schema_version: e.v,
        payload: e.attributes,
      };
    }
    case "talent": {
      const e = item as TalentItem;
      return {
        event_id: e.uuid,
        event_type: e.kind,
        entity_id: e.subject,
        source_sequence: e.revision,
        source_updated_at: e.updated,
        effective_date: e.asOf,
        schema_version: e.version,
        payload: e.body,
      };
    }
  }
}

export function normalize(source: SourceId, item: Envelope, ctx: DeliveryContext): RawRecord {
  const v = viewEnvelope(source, item);
  const payload = canonicalJson(v.payload);
  return {
    event_id: v.event_id,
    source,
    event_type: v.event_type,
    entity_id: v.entity_id,
    source_sequence: v.source_sequence,
    source_updated_at: v.source_updated_at,
    effective_date: v.effective_date,
    schema_version: v.schema_version,
    payload,
    payload_sha256: sha256HexSync(payload),
    received_at: ctx.receivedAt,
    delivery_id: ctx.newDeliveryId ? ctx.newDeliveryId() : crypto.randomUUID(),
    ingest_request_id: ctx.requestId,
    producer: ctx.producer,
  };
}

export function normalizeBatch(source: SourceId, items: readonly Envelope[], ctx: DeliveryContext): RawRecord[] {
  return items.map((item) => normalize(source, item, ctx));
}

const COLUMN_ORDER = [...RAW_RECORD_COLUMNS];

/** Records as NDJSON in RAW_RECORD_COLUMNS order, one newline-terminated line each (one landing row). */
export function toNdjson(records: readonly RawRecord[]): string {
  return records.map((r) => `${JSON.stringify(r, COLUMN_ORDER)}\n`).join("");
}
