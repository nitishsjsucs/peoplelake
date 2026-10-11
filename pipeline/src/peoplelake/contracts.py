"""Pydantic mirrors of the zod contracts in src/shared/contracts.ts (JSON Schemas in contracts/).

Strict models: unknown fields are rejected and integers stay integers (a float such as 0.8 or 1.0
fails), matching the Worker's validation. tests/test_contracts.py checks field names and required
sets against the committed JSON Schemas.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationInfo, field_validator, model_validator

Uuid = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
IsoTimestamp = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
EmployeeId = Annotated[str, StringConstraints(pattern=r"^E\d{6}$")]
DepartmentId = Annotated[str, StringConstraints(pattern=r"^D\d{2}$")]
JobCode = Annotated[str, StringConstraints(pattern=r"^J\d{2}$")]
LocationId = Annotated[str, StringConstraints(pattern=r"^L\d$")]
RequisitionId = Annotated[str, StringConstraints(pattern=r"^Q\d{6}$")]
ApplicationId = Annotated[str, StringConstraints(pattern=r"^A\d{6}$")]
CandidateId = Annotated[str, StringConstraints(pattern=r"^C\d{6}$")]
OfferId = Annotated[str, StringConstraints(pattern=r"^O\d{6}$")]
Code = Annotated[str, StringConstraints(min_length=1, max_length=64)]

# Mirrors MAX_BATCH_EVENTS in src/shared/contracts.ts: at most 50 events per ingest request (Workers Free CPU).
MAX_BATCH_EVENTS = 50
NonEmpty = Annotated[str, StringConstraints(min_length=1)]
NonNegInt = Annotated[int, Field(ge=0, le=2**53 - 1)]
PosInt = Annotated[int, Field(gt=0, le=2**53 - 1)]
FteBp = Annotated[int, Field(ge=1, le=10000)]

SourceId = Literal["hris", "ats", "talent"]
PUBLISHED_MODELS: tuple[str, ...] = (
    "dim_department",
    "dim_job",
    "dim_employee_history",
    "dim_employee",
    "fct_employment_events",
    "fct_offers",
    "fct_workforce_monthly",
    "metrics_workforce_monthly",
    "fct_compensation_history",
    "fct_performance_reviews",
)
PublishedModel = Literal[
    "dim_department",
    "dim_job",
    "dim_employee_history",
    "dim_employee",
    "fct_employment_events",
    "fct_offers",
    "fct_workforce_monthly",
    "metrics_workforce_monthly",
    "fct_compensation_history",
    "fct_performance_reviews",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def _omit_not_null(*fields: str) -> Any:
    """zod `.optional()` fields may be omitted but never sent as null."""

    def check(cls: type, value: Any, info: ValidationInfo) -> Any:
        if value is None:
            raise ValueError(f"{info.field_name} may be omitted but not null")
        return value

    return field_validator(*fields, mode="before")(classmethod(check))


# --- hris ---------------------------------------------------------------------------------------


class HireData(Strict):
    spell_no: PosInt
    department_id: DepartmentId
    job_code: JobCode
    location_id: LocationId
    fte_bp: FteBp
    ats_candidate_id: CandidateId | None
    hire_source: Literal["initial_load", "external", "rehire"]


class TerminationData(Strict):
    termination_type: Literal["voluntary", "involuntary"]
    reason_code: Code


class TransferData(Strict):
    from_department_id: DepartmentId
    to_department_id: DepartmentId


class JobChangeData(Strict):
    from_job_code: JobCode
    to_job_code: JobCode
    change_type: Literal["promotion", "lateral"]


class FteChangeData(Strict):
    from_fte_bp: FteBp
    to_fte_bp: FteBp


class CorrectedFields(Strict):
    effective_date: IsoDate | None = None
    to_department_id: DepartmentId | None = None
    to_fte_bp: FteBp | None = None
    _no_null = _omit_not_null("effective_date", "to_department_id", "to_fte_bp")

    @model_validator(mode="after")
    def _at_least_one(self) -> CorrectedFields:
        if not self.model_fields_set:
            raise ValueError("corrected_fields needs at least one field")
        return self


class CorrectionData(Strict):
    corrects_event_id: Uuid
    corrected_fields: CorrectedFields


class RescindData(Strict):
    rescinds_event_id: Uuid


class _HrisCommon(Strict):
    eventId: Uuid
    workerId: EmployeeId
    sequence: NonNegInt
    recordedAt: IsoTimestamp
    effectiveDate: IsoDate
    schemaVersion: Literal[1]


class HrisHired(_HrisCommon):
    eventType: Literal["worker.hired", "worker.rehired"]
    data: HireData


class HrisTerminated(_HrisCommon):
    eventType: Literal["worker.terminated"]
    data: TerminationData


class HrisTransferred(_HrisCommon):
    eventType: Literal["worker.transferred"]
    data: TransferData


class HrisJobChanged(_HrisCommon):
    eventType: Literal["worker.job_changed"]
    data: JobChangeData


class HrisFteChanged(_HrisCommon):
    eventType: Literal["worker.fte_changed"]
    data: FteChangeData


class HrisCorrected(_HrisCommon):
    eventType: Literal["worker.event_corrected"]
    data: CorrectionData


class HrisRescinded(_HrisCommon):
    eventType: Literal["worker.event_rescinded"]
    data: RescindData


HrisEvent = Annotated[
    HrisHired | HrisTerminated | HrisTransferred | HrisJobChanged | HrisFteChanged | HrisCorrected | HrisRescinded,
    Field(discriminator="eventType"),
]


class HrisBatch(Strict):
    events: Annotated[list[HrisEvent], Field(min_length=1, max_length=MAX_BATCH_EVENTS)]


# --- ats ----------------------------------------------------------------------------------------


class AtsObjectRequisition(Strict):
    kind: Literal["requisition"]
    id: RequisitionId


class AtsObjectApplication(Strict):
    kind: Literal["application"]
    id: ApplicationId


class AtsObjectOffer(Strict):
    kind: Literal["offer"]
    id: OfferId


class _AtsCommon(Strict):
    id: Uuid
    seq: NonNegInt
    occurred_at: IsoTimestamp
    effective_on: IsoDate
    v: Literal[1]


class ReqOpenedAttrs(Strict):
    requisition_id: RequisitionId
    department_id: DepartmentId
    job_code: JobCode


class ReqClosedAttrs(Strict):
    requisition_id: RequisitionId
    close_reason: Literal["filled", "cancelled"]


class AppSubmittedAttrs(Strict):
    application_id: ApplicationId
    requisition_id: RequisitionId
    candidate_id: CandidateId


class StageChangedAttrs(Strict):
    application_id: ApplicationId
    from_stage: Code
    to_stage: Code


class OfferExtendedAttrs(Strict):
    offer_id: OfferId
    application_id: ApplicationId
    requisition_id: RequisitionId
    candidate_id: CandidateId
    proposed_start_date: IsoDate


class OfferAcceptedAttrs(Strict):
    offer_id: OfferId
    start_date: IsoDate


class OfferOnlyAttrs(Strict):
    offer_id: OfferId


class AtsReqOpened(_AtsCommon):
    type: Literal["requisition.opened"]
    object: AtsObjectRequisition
    attributes: ReqOpenedAttrs


class AtsReqClosed(_AtsCommon):
    type: Literal["requisition.closed"]
    object: AtsObjectRequisition
    attributes: ReqClosedAttrs


class AtsAppSubmitted(_AtsCommon):
    type: Literal["application.submitted"]
    object: AtsObjectApplication
    attributes: AppSubmittedAttrs


class AtsStageChanged(_AtsCommon):
    type: Literal["application.stage_changed"]
    object: AtsObjectApplication
    attributes: StageChangedAttrs


class AtsOfferExtended(_AtsCommon):
    type: Literal["offer.extended"]
    object: AtsObjectOffer
    attributes: OfferExtendedAttrs


class AtsOfferAccepted(_AtsCommon):
    type: Literal["offer.accepted"]
    object: AtsObjectOffer
    attributes: OfferAcceptedAttrs


class AtsOfferClosed(_AtsCommon):
    type: Literal["offer.declined", "offer.rescinded"]
    object: AtsObjectOffer
    attributes: OfferOnlyAttrs


AtsRecord = Annotated[
    AtsReqOpened
    | AtsReqClosed
    | AtsAppSubmitted
    | AtsStageChanged
    | AtsOfferExtended
    | AtsOfferAccepted
    | AtsOfferClosed,
    Field(discriminator="type"),
]


class AtsBatch(Strict):
    records: Annotated[list[AtsRecord], Field(min_length=1, max_length=MAX_BATCH_EVENTS)]


# --- talent -------------------------------------------------------------------------------------


class CompBody(Strict):
    change_id: Annotated[str, StringConstraints(pattern=r"^K\d{6}$")]
    reason: Literal["initial", "hire", "rehire", "merit", "promotion", "adjustment"]
    base_salary: NonNegInt
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
    bonus_target_bp: Annotated[int, Field(ge=0, le=10000)]


class ReviewBody(Strict):
    review_id: Annotated[str, StringConstraints(pattern=r"^V\d{6}$")]
    cycle: Annotated[str, StringConstraints(pattern=r"^\d{4}$")]
    rating: Annotated[int, Field(ge=1, le=5)]
    reviewer_id: EmployeeId


class _TalentCommon(Strict):
    uuid: Uuid
    subject: EmployeeId
    revision: NonNegInt
    updated: IsoTimestamp
    asOf: IsoDate
    version: Literal[1]


class TalentComp(_TalentCommon):
    kind: Literal["compensation.changed"]
    body: CompBody


class TalentReview(_TalentCommon):
    kind: Literal["review.submitted"]
    body: ReviewBody


TalentItem = Annotated[TalentComp | TalentReview, Field(discriminator="kind")]


class TalentBatch(Strict):
    items: Annotated[list[TalentItem], Field(min_length=1, max_length=MAX_BATCH_EVENTS)]


# --- raw record ---------------------------------------------------------------------------------

RAW_RECORD_COLUMNS: tuple[str, ...] = (
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
)


class RawRecord(Strict):
    event_id: Uuid
    source: SourceId
    event_type: NonEmpty
    entity_id: NonEmpty
    source_sequence: NonNegInt
    source_updated_at: IsoTimestamp
    effective_date: IsoDate
    schema_version: Annotated[int, Field(ge=1, le=2147483647)]
    payload: str
    payload_sha256: Sha256Hex
    received_at: IsoTimestamp
    delivery_id: Uuid
    ingest_request_id: NonEmpty
    producer: NonEmpty


# --- jobs and results ---------------------------------------------------------------------------

FaultKind = Literal[
    "crash_after_load",
    "fail_transform_model",
    "duplicate_result",
    "skip_claim",
    "commit_step_error",
    "rewind_watermark",
    "recommit_sink_files",
]


class FaultSpec(Strict):
    run_seq: PosInt
    kind: FaultKind
    model: NonEmpty | None = None
    snapshots: PosInt | None = None
    count: PosInt | None = None
    attempt: PosInt | None = None
    job: Literal["load", "transform"] | None = None
    _no_null = _omit_not_null("model", "snapshots", "count", "attempt", "job")


class JobInput(Strict):
    from_snapshot: str | None
    to_snapshot: str | None = None  # nullable and optional in zod
    full_refresh: bool
    dataset_suffix: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]+$")] | None = None
    # Load jobs: the landing rolls of the Coordinator generation the committer lists (SPEC 29.4.1).
    landing_prefix: Annotated[str, StringConstraints(pattern=r"^landing/raw_events/g\d+/$")] | None = None
    _no_null = _omit_not_null("dataset_suffix", "landing_prefix")


class JobSpec(Strict):
    job_id: NonEmpty
    run_id: NonEmpty
    load_seq: NonNegInt
    kind: Literal["load", "transform"]
    attempt: PosInt
    mode: Literal["incremental", "replay"]
    input: JobInput
    lease_seconds: PosInt
    faults: list[FaultSpec] | None = None
    _no_null = _omit_not_null("faults")


class LakeRead(Strict):
    table: Literal["peoplelake.raw_events"]
    from_snapshot: str | None
    to_snapshot: str | None
    snapshots_read: NonNegInt
    fallback_full_scan: bool
    landing_through: str | None = None  # nullable and optional in zod: the committer's cursor at to_snapshot


Histogram = list[tuple[NonNegInt, NonNegInt]]


class FailedResult(Strict):
    job_id: NonEmpty
    run_id: NonEmpty
    attempt: PosInt
    status: Literal["failed", "expired"]
    error: str
    duration_ms: NonNegInt | None = None
    bytes_billed: NonNegInt | None = None  # BigQuery: billed before the failure (the monthly guard counts it)
    _no_null = _omit_not_null("duration_ms", "bytes_billed")


class LoadResult(Strict):
    job_id: NonEmpty
    run_id: NonEmpty
    attempt: PosInt
    status: Literal["succeeded"]
    lake: LakeRead
    rows_read: NonNegInt
    rows_inserted: NonNegInt
    duplicate_deliveries_skipped: NonNegInt
    unique_new_events: NonNegInt
    raw_max_load_seq: NonNegInt | None
    min_effective_date_new: IsoDate | None
    received_histogram_10s: Histogram
    warehouse: Literal["duckdb", "bigquery"]
    duration_ms: NonNegInt
    bytes_billed: NonNegInt | None = None  # BigQuery loads: the monthly guard sums it with the transforms'
    _no_null = _omit_not_null("bytes_billed")


class DbtStats(Strict):
    success: bool
    models_ok: NonNegInt
    models_error: NonNegInt
    tests_pass: NonNegInt
    tests_warn: NonNegInt
    tests_error: NonNegInt
    elapsed_ms: NonNegInt
    bytes_billed: NonNegInt | None = None
    _no_null = _omit_not_null("bytes_billed")


class Checks(Strict):
    error: dict[str, NonNegInt]
    warn: dict[str, NonNegInt]


class MetricsArtifact(Strict):
    key: NonEmpty
    sha256: Sha256Hex
    rows: NonNegInt


class TransformResult(Strict):
    job_id: NonEmpty
    run_id: NonEmpty
    attempt: PosInt
    status: Literal["succeeded"]
    dbt: DbtStats
    checks: Checks
    digests: dict[PublishedModel, Sha256Hex]
    digest_version: Literal[1]
    engine: Literal["duckdb", "bigquery"]
    transformed_through_seq: NonNegInt
    ops_freshness_histogram_10s: Histogram
    metrics_artifact: MetricsArtifact
    duration_ms: NonNegInt
    bytes_billed: NonNegInt | None = None  # BigQuery: every byte the job billed, dbt and the runner's queries
    _no_null = _omit_not_null("bytes_billed")


def dump_contract(model: BaseModel) -> dict:
    """JSON-ready dict without unset optional fields (the zod contracts use optional, not null)."""
    return model.model_dump(mode="json", exclude_unset=True)
