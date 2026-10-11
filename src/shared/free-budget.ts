// Workers Free plan budget (SPEC 29): the production guard values, the bounds parseConfig enforces in
// production, and the constants the usage estimates use. Shared by the Worker, the scripts and the tests,
// so a change that would pass a Free allowance fails a test instead of reaching production.

/** Production values of the run guards (SPEC 29.6); wrangler.jsonc env.production must equal these. */
export const PRODUCTION_GUARDS = {
  RUN_MIN_INTERVAL_SECONDS: 240,
  FAILURE_BACKOFF_BASE_MINUTES: 5,
  FAILURE_BACKOFF_MAX_MINUTES: 360,
  AUTO_RUNS_MAX_PER_DAY: 30,
  BQ_MONTHLY_BYTES_CAP: 275_000_000_000,
  HEARTBEAT_MINUTES: 0,
} as const;

/** parseConfig refuses production values outside these bounds (SPEC 29.6). */
export const GUARD_BOUNDS = {
  runMinIntervalSecondsAtLeast: 240,
  failureBackoffBaseMinutesAtLeast: 5,
  autoRunsMaxPerDayAtMost: 30,
  bqMonthlyBytesCapAtMost: 275_000_000_000,
  heartbeatMinutesAtMost: 0,
} as const;

/** Bytes a transform run is assumed to bill (SPEC 29.5: about 3 GB, mostly the 10 MB minimum per table). */
export const BQ_TRANSFORM_RESERVE_BYTES = 3_000_000_000;

/** The only cron expression (1 of the account's 5 Cron Triggers): sweeps and the backstop. */
export const CRON_EXPRESSION = "*/5 * * * *";

/** Durable Object SQL usage counters are written to storage at most this often. */
export const USAGE_FLUSH_MS = 5 * 60_000;

/** Minutes automatic triggers wait after `failures` consecutive failed runs: min(base * 2^(k-1), max). */
export function backoffMinutes(failures: number, baseMinutes: number, maxMinutes: number): number {
  if (failures <= 0 || baseMinutes <= 0) return 0;
  return Math.min(baseMinutes * 2 ** (failures - 1), maxMinutes);
}
