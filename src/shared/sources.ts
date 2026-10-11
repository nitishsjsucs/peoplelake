// The three simulated enterprise sources. Generic names on purpose: no vendor products.
export const SOURCE_IDS = ["hris", "ats", "talent"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_DOMAINS = {
  hris: ["hr"],
  ats: ["recruiting"],
  talent: ["compensation", "performance"],
} as const satisfies Record<SourceId, readonly string[]>;

export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value);
}

export const HRIS_EVENT_TYPES = [
  "worker.hired",
  "worker.rehired",
  "worker.terminated",
  "worker.transferred",
  "worker.job_changed",
  "worker.fte_changed",
  "worker.event_corrected",
  "worker.event_rescinded",
] as const;

export const ATS_EVENT_TYPES = [
  "requisition.opened",
  "requisition.closed",
  "application.submitted",
  "application.stage_changed",
  "offer.extended",
  "offer.accepted",
  "offer.declined",
  "offer.rescinded",
] as const;

export const TALENT_EVENT_TYPES = ["compensation.changed", "review.submitted"] as const;
