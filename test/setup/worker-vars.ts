// Variables the worker test project overrides on top of wrangler.jsonc (tests only).
export const TEST_ROLE_MAP = {
  emails: {
    "dev@peoplelake.local": ["viewer", "operator"],
    "viewer@peoplelake.local": ["viewer"],
  },
  service_tokens: {
    "src-hris.access": "source:hris",
    "src-ats.access": "source:ats",
    "src-talent.access": "source:talent",
    "runner.access": "runner",
  },
} as const;

export const WORKER_TEST_VARS = {
  ACCESS_ROLE_MAP: JSON.stringify(TEST_ROLE_MAP),
  JOB_LEASE_SECONDS: "20",
  JOB_CLAIM_TIMEOUT_SECONDS: "10",
  SINK_ROLL_SECONDS: "60",
  LOCAL_SINK_MAX_RECORDS: "50",
} as const;
