// Data contracts shared by the Worker, the scripts and (through contracts/*.schema.json) the Python
// runner. zod is the single source; `node scripts/gen-contracts.ts` writes the JSON Schemas and a
// test fails when they are stale. Payload numbers are integers only (SPEC 5.4).
import { z } from "zod";
import { PUBLISHED_MODELS } from "./metrics.ts";
import { SOURCE_IDS } from "./sources.ts";

const int = () => z.number().int();
const nonNegInt = () => z.number().int().nonnegative();

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "invalid calendar date");
export const IsoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/);
export const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const EmployeeId = z.string().regex(/^E\d{6}$/);
const DepartmentId = z.string().regex(/^D\d{2}$/);
const JobCode = z.string().regex(/^J\d{2}$/);
const LocationId = z.string().regex(/^L\d$/);
const RequisitionId = z.string().regex(/^Q\d{6}$/);
const ApplicationId = z.string().regex(/^A\d{6}$/);
const CandidateId = z.string().regex(/^C\d{6}$/);
const OfferId = z.string().regex(/^O\d{6}$/);
const FteBp = z.number().int().min(1).max(10000);
const Code = z.string().min(1).max(64);

// ---------------------------------------------------------------------------------------------
// hris: POST /v1/ingest/hris {"events": [...]}
// ---------------------------------------------------------------------------------------------
const hrisCommon = {
  eventId: Uuid,
  workerId: EmployeeId,
  sequence: nonNegInt(),
  recordedAt: IsoTimestamp,
  effectiveDate: IsoDate,
  schemaVersion: z.literal(1),
};
const HireData = z
  .object({
    spell_no: z.number().int().min(1),
    department_id: DepartmentId,
    job_code: JobCode,
    location_id: LocationId,
    fte_bp: FteBp,
    ats_candidate_id: CandidateId.nullable(),
    hire_source: z.enum(["initial_load", "external", "rehire"]),
  })
  .strict();

export const HrisEvent = z.discriminatedUnion("eventType", [
  z.object({ ...hrisCommon, eventType: z.literal("worker.hired"), data: HireData }).strict(),
  z.object({ ...hrisCommon, eventType: z.literal("worker.rehired"), data: HireData }).strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.terminated"),
      data: z.object({ termination_type: z.enum(["voluntary", "involuntary"]), reason_code: Code }).strict(),
    })
    .strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.transferred"),
      data: z.object({ from_department_id: DepartmentId, to_department_id: DepartmentId }).strict(),
    })
    .strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.job_changed"),
      data: z
        .object({ from_job_code: JobCode, to_job_code: JobCode, change_type: z.enum(["promotion", "lateral"]) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.fte_changed"),
      data: z.object({ from_fte_bp: FteBp, to_fte_bp: FteBp }).strict(),
    })
    .strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.event_corrected"),
      data: z
        .object({
          corrects_event_id: Uuid,
          corrected_fields: z
            .object({ effective_date: IsoDate, to_department_id: DepartmentId, to_fte_bp: FteBp })
            .partial()
            .strict()
            .refine((f) => Object.keys(f).length >= 1, "corrected_fields needs at least one field"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...hrisCommon,
      eventType: z.literal("worker.event_rescinded"),
      data: z.object({ rescinds_event_id: Uuid }).strict(),
    })
    .strict(),
]);
export type HrisEvent = z.infer<typeof HrisEvent>;

// ---------------------------------------------------------------------------------------------
// ats: POST /v1/ingest/ats {"records": [...]}
// ---------------------------------------------------------------------------------------------
const atsCommon = {
  id: Uuid,
  seq: nonNegInt(),
  occurred_at: IsoTimestamp,
  effective_on: IsoDate,
  v: z.literal(1),
};
const atsObject = (kind: "requisition" | "application" | "offer", id: z.ZodString) =>
  z.object({ kind: z.literal(kind), id }).strict();

export const AtsRecord = z.discriminatedUnion("type", [
  z
    .object({
      ...atsCommon,
      type: z.literal("requisition.opened"),
      object: atsObject("requisition", RequisitionId),
      attributes: z.object({ requisition_id: RequisitionId, department_id: DepartmentId, job_code: JobCode }).strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("requisition.closed"),
      object: atsObject("requisition", RequisitionId),
      attributes: z.object({ requisition_id: RequisitionId, close_reason: z.enum(["filled", "cancelled"]) }).strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("application.submitted"),
      object: atsObject("application", ApplicationId),
      attributes: z
        .object({ application_id: ApplicationId, requisition_id: RequisitionId, candidate_id: CandidateId })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("application.stage_changed"),
      object: atsObject("application", ApplicationId),
      attributes: z.object({ application_id: ApplicationId, from_stage: Code, to_stage: Code }).strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("offer.extended"),
      object: atsObject("offer", OfferId),
      attributes: z
        .object({
          offer_id: OfferId,
          application_id: ApplicationId,
          requisition_id: RequisitionId,
          candidate_id: CandidateId,
          proposed_start_date: IsoDate,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("offer.accepted"),
      object: atsObject("offer", OfferId),
      attributes: z.object({ offer_id: OfferId, start_date: IsoDate }).strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("offer.declined"),
      object: atsObject("offer", OfferId),
      attributes: z.object({ offer_id: OfferId }).strict(),
    })
    .strict(),
  z
    .object({
      ...atsCommon,
      type: z.literal("offer.rescinded"),
      object: atsObject("offer", OfferId),
      attributes: z.object({ offer_id: OfferId }).strict(),
    })
    .strict(),
]);
export type AtsRecord = z.infer<typeof AtsRecord>;

// ---------------------------------------------------------------------------------------------
// talent: POST /v1/ingest/talent {"items": [...]}
// ---------------------------------------------------------------------------------------------
const talentCommon = {
  uuid: Uuid,
  subject: EmployeeId,
  revision: nonNegInt(),
  updated: IsoTimestamp,
  asOf: IsoDate,
  version: z.literal(1),
};
export const TalentItem = z.discriminatedUnion("kind", [
  z
    .object({
      ...talentCommon,
      kind: z.literal("compensation.changed"),
      body: z
        .object({
          change_id: z.string().regex(/^K\d{6}$/),
          reason: z.enum(["initial", "hire", "rehire", "merit", "promotion", "adjustment"]),
          base_salary: nonNegInt(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          bonus_target_bp: z.number().int().min(0).max(10000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...talentCommon,
      kind: z.literal("review.submitted"),
      body: z
        .object({
          review_id: z.string().regex(/^V\d{6}$/),
          cycle: z.string().regex(/^\d{4}$/),
          rating: z.number().int().min(1).max(5),
          reviewer_id: EmployeeId,
        })
        .strict(),
    })
    .strict(),
]);
export type TalentItem = z.infer<typeof TalentItem>;

export const MAX_BATCH_EVENTS = 500;
export const MAX_BODY_BYTES = 1024 * 1024;

export const HrisBatch = z.object({ events: z.array(HrisEvent).min(1).max(MAX_BATCH_EVENTS) }).strict();
export const AtsBatch = z.object({ records: z.array(AtsRecord).min(1).max(MAX_BATCH_EVENTS) }).strict();
export const TalentBatch = z.object({ items: z.array(TalentItem).min(1).max(MAX_BATCH_EVENTS) }).strict();

// ---------------------------------------------------------------------------------------------
// RawRecord: one row per accepted delivery (stream, Iceberg and warehouse raw table)
// ---------------------------------------------------------------------------------------------
export const RAW_RECORD_COLUMNS = [
  "event_id",
  "source",
  "event_type",
  "entity_id",
  "source_sequence",
  "source_updated_at",
  "effective_date",
  "schema_version",
  "payload",
  "payload_sha256",
  "received_at",
  "delivery_id",
  "ingest_request_id",
  "producer",
] as const;

export const RawRecord = z
  .object({
    event_id: Uuid,
    source: z.enum(SOURCE_IDS),
    event_type: z.string().min(1),
    entity_id: z.string().min(1),
    source_sequence: nonNegInt(),
    source_updated_at: IsoTimestamp,
    effective_date: IsoDate,
    schema_version: z.number().int().min(1).max(2147483647),
    payload: z.string(),
    payload_sha256: Sha256Hex,
    received_at: IsoTimestamp,
    delivery_id: Uuid,
    ingest_request_id: z.string().min(1),
    producer: z.string().min(1),
  })
  .strict();
export type RawRecord = z.infer<typeof RawRecord>;

// ---------------------------------------------------------------------------------------------
// Runner jobs and results
// ---------------------------------------------------------------------------------------------
export const FAULT_KINDS = [
  "crash_after_load",
  "fail_transform_model",
  "duplicate_result",
  "skip_claim",
  "commit_step_error",
  "rewind_watermark",
  "recommit_sink_files",
] as const;

export const FaultSpec = z
  .object({
    run_seq: z.number().int().positive(),
    kind: z.enum(FAULT_KINDS),
    model: z.string().min(1).optional(),
    snapshots: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict();
export type FaultSpec = z.infer<typeof FaultSpec>;

export const JobKind = z.enum(["load", "transform"]);
export type JobKind = z.infer<typeof JobKind>;
export const RunMode = z.enum(["incremental", "replay"]);
export type RunMode = z.infer<typeof RunMode>;

export const JobSpec = z
  .object({
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    load_seq: nonNegInt(),
    kind: JobKind,
    attempt: z.number().int().positive(),
    mode: RunMode,
    input: z
      .object({
        from_snapshot: z.string().nullable(),
        to_snapshot: z.string().nullable().optional(),
        full_refresh: z.boolean(),
        dataset_suffix: z.string().regex(/^[a-z0-9_]+$/).optional(),
      })
      .strict(),
    lease_seconds: z.number().int().positive(),
    faults: z.array(FaultSpec).optional(),
  })
  .strict();
export type JobSpec = z.infer<typeof JobSpec>;

const Histogram10s = z.array(z.tuple([nonNegInt(), nonNegInt()]));
const Engine = z.enum(["duckdb", "bigquery"]);

const failedOrExpired = {
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["failed", "expired"]),
  error: z.string(),
  duration_ms: nonNegInt().optional(),
};

export const LoadResultSucceeded = z
  .object({
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    attempt: z.number().int().positive(),
    status: z.literal("succeeded"),
    lake: z
      .object({
        table: z.literal("peoplelake.raw_events"),
        from_snapshot: z.string().nullable(),
        to_snapshot: z.string().nullable(),
        snapshots_read: nonNegInt(),
        fallback_full_scan: z.boolean(),
      })
      .strict(),
    rows_read: nonNegInt(),
    rows_inserted: nonNegInt(),
    duplicate_deliveries_skipped: nonNegInt(),
    unique_new_events: nonNegInt(),
    raw_max_load_seq: nonNegInt().nullable(),
    min_effective_date_new: IsoDate.nullable(),
    received_histogram_10s: Histogram10s,
    warehouse: Engine,
    duration_ms: nonNegInt(),
  })
  .strict();
export const LoadResult = z.union([LoadResultSucceeded, z.object(failedOrExpired).strict()]);
export type LoadResult = z.infer<typeof LoadResult>;

const Digests = z.partialRecord(z.enum(PUBLISHED_MODELS), Sha256Hex);

export const TransformResultSucceeded = z
  .object({
    job_id: z.string().min(1),
    run_id: z.string().min(1),
    attempt: z.number().int().positive(),
    status: z.literal("succeeded"),
    dbt: z
      .object({
        success: z.boolean(),
        models_ok: nonNegInt(),
        models_error: nonNegInt(),
        tests_pass: nonNegInt(),
        tests_warn: nonNegInt(),
        tests_error: nonNegInt(),
        elapsed_ms: nonNegInt(),
        bytes_billed: nonNegInt().optional(),
      })
      .strict(),
    checks: z.object({ error: z.record(z.string(), nonNegInt()), warn: z.record(z.string(), nonNegInt()) }).strict(),
    digests: Digests,
    digest_version: z.literal(1),
    engine: Engine,
    transformed_through_seq: nonNegInt(),
    ops_freshness_histogram_10s: Histogram10s,
    metrics_artifact: z.object({ key: z.string().min(1), sha256: Sha256Hex, rows: nonNegInt() }).strict(),
    duration_ms: nonNegInt(),
  })
  .strict();
export const TransformResult = z.union([TransformResultSucceeded, z.object(failedOrExpired).strict()]);
export type TransformResult = z.infer<typeof TransformResult>;

/** Every contract with a committed JSON Schema in contracts/ (file stem -> schema). */
export const CONTRACT_SCHEMAS = {
  "raw-record": RawRecord,
  "source-hris": HrisBatch,
  "source-ats": AtsBatch,
  "source-talent": TalentBatch,
  job: JobSpec,
  "load-result": LoadResult,
  "transform-result": TransformResult,
} as const;
export type ContractName = keyof typeof CONTRACT_SCHEMAS;
