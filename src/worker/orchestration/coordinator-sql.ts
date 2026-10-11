// Coordinator ledger schema (SPEC 8.1, 29.4.3). run_freshness also records which committed run published
// the events a load introduced (published_by, published_at), so a run whose transform failed is attributed
// to the next committed run. The indexes keep every per-tick and per-request query's rows read flat as the
// ledger grows (the Workers Free plan allows 5 million rows read a day per account).
export const COORDINATOR_DDL = [
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    seq INTEGER UNIQUE NOT NULL,
    load_seq INTEGER UNIQUE NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('incremental', 'replay')),
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'failed')),
    requested_at INTEGER, started_at INTEGER, finished_at INTEGER, published_at INTEGER,
    from_snapshot TEXT, to_snapshot TEXT, rows_inserted INTEGER, duplicates_skipped INTEGER,
    transform_skipped INTEGER DEFAULT 0, load_attempts INTEGER DEFAULT 0, transform_attempts INTEGER DEFAULT 0,
    digests_json TEXT, checks_json TEXT, metrics_key TEXT, error TEXT, options_json TEXT,
    transform_skip_reason TEXT, landing_through TEXT, steps_used INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('load', 'transform')),
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed', 'expired')),
    input_json TEXT NOT NULL,
    created_at INTEGER, claimed_at INTEGER, claimed_by TEXT, lease_until INTEGER,
    finished_at INTEGER, result_json TEXT, dispatch_ref TEXT,
    UNIQUE (run_id, kind, attempt)
  )`,
  `CREATE TABLE IF NOT EXISTS watermarks (name TEXT PRIMARY KEY, value TEXT, run_id TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS run_freshness (
    run_id TEXT NOT NULL, bucket_start_s INTEGER NOT NULL, events INTEGER NOT NULL,
    published_by TEXT, published_at INTEGER,
    PRIMARY KEY (run_id, bucket_start_s)
  )`,
  `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS jobs_run ON jobs (run_id)`,
  `CREATE INDEX IF NOT EXISTS runs_status_started ON runs (status, started_at)`,
  `CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)`,
  `CREATE INDEX IF NOT EXISTS run_freshness_bucket ON run_freshness (bucket_start_s)`,
  `CREATE INDEX IF NOT EXISTS run_freshness_published_by ON run_freshness (published_by)`,
];

/** Columns added to tables a local state may have created earlier: [table, column, type]. */
export const COORDINATOR_ADDED_COLUMNS: readonly (readonly [string, string, string])[] = [
  ["runs", "transform_skip_reason", "TEXT"],
  ["runs", "landing_through", "TEXT"],
  ["runs", "steps_used", "INTEGER"],
];

export type RunRow = {
  run_id: string;
  seq: number;
  load_seq: number;
  mode: "incremental" | "replay";
  reason: string;
  status: "active" | "committed" | "failed";
  requested_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  published_at: number | null;
  from_snapshot: string | null;
  to_snapshot: string | null;
  rows_inserted: number | null;
  duplicates_skipped: number | null;
  transform_skipped: number;
  load_attempts: number;
  transform_attempts: number;
  digests_json: string | null;
  checks_json: string | null;
  metrics_key: string | null;
  error: string | null;
  options_json: string | null;
  transform_skip_reason: string | null;
  landing_through: string | null;
  steps_used: number | null;
};

export type JobRow = {
  job_id: string;
  run_id: string;
  kind: "load" | "transform";
  attempt: number;
  status: "queued" | "claimed" | "succeeded" | "failed" | "expired";
  input_json: string;
  created_at: number | null;
  claimed_at: number | null;
  claimed_by: string | null;
  lease_until: number | null;
  finished_at: number | null;
  result_json: string | null;
  dispatch_ref: string | null;
};
