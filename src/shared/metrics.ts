// The five workforce metrics. One definition lives in dbt (metrics_workforce_monthly); this list
// names them for the API, the ask endpoint and the evals.
export const METRIC_IDS = ["headcount", "fte", "hires", "departures", "offer_acceptance_rate"] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const METRIC_LABELS = {
  headcount: "Headcount at month end",
  fte: "Full-time equivalents at month end",
  hires: "Hires and rehires in the month",
  departures: "Effective terminations in the month",
  offer_acceptance_rate: "Offer acceptance rate by decision month",
} as const satisfies Record<MetricId, string>;

// Models covered by output digests (ADR 0005).
export const PUBLISHED_MODELS = [
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
] as const;
export type PublishedModel = (typeof PUBLISHED_MODELS)[number];
