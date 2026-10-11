// Read-only client for the Worker's /api/* routes (the dashboard never calls anything else).
//
// Production: the page and /api/* sit behind Cloudflare Access on the same hostname. The browser holds
// the Access session cookie, and Access adds the Cf-Access-Jwt-Assertion header that the Worker verifies.
// Local (wrangler dev): there is no Access in front, so the page sends a dev JWT that the person pasted
// (`peoplelake auth dev-token operator --ttl 3600`); it lives in sessionStorage for this tab only.

export const DEV_TOKEN_KEY = "peoplelake.devToken";
const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

export interface Health {
  ok: boolean;
  version: string;
  environment: "local" | "production";
  lake_mode: string;
}

export interface RunSummary {
  run_id: string;
  seq: number;
  mode: "incremental" | "replay";
  reason: string;
  status: "active" | "committed" | "failed";
  requested_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  published_at: number | null;
  rows_inserted: number | null;
  duplicates_skipped: number | null;
  transform_skipped: boolean;
  load_attempts: number;
  transform_attempts: number;
  error: string | null;
}

export interface Checks {
  error: Record<string, number>;
  warn: Record<string, number>;
}

export interface RunFull extends RunSummary {
  load_seq: number;
  from_snapshot: string | null;
  to_snapshot: string | null;
  digests: Record<string, string> | null;
  checks: Checks | null;
  metrics_key: string | null;
}

export interface Job {
  job_id: string;
  run_id: string;
  kind: "load" | "transform";
  attempt: number;
  status: "queued" | "claimed" | "succeeded" | "failed" | "expired";
  created_at: number | null;
  claimed_at: number | null;
  claimed_by: string | null;
  finished_at: number | null;
  result: { duration_ms?: number; error?: string; rows_inserted?: number } | null;
}

export interface FreshnessSummary {
  events: number;
  pending_events: number;
  p50_s: number | null;
  p90_s: number | null;
  p95_s: number | null;
  p99_s: number | null;
  max_s: number | null;
  share_within_15m: number | null;
}

export interface Freshness {
  window: string;
  method: string;
  overall: FreshnessSummary;
  runs: ({ run_id: string } & FreshnessSummary)[];
}

export interface MetricsRow {
  month: string;
  department_id: string;
  headcount: string | null;
  fte: string | null;
  hires: string | null;
  rehires: string | null;
  departures: string | null;
  transfers_in: string | null;
  transfers_out: string | null;
  offers_extended: string | null;
  offers_accepted: string | null;
  offers_declined: string | null;
  offer_acceptance_rate: string | null;
}

export interface MetricsSnapshot {
  run_id: string;
  engine: string;
  profile: string;
  rows: MetricsRow[];
}

export interface Status {
  active_run_id: string | null;
  pending_mode: string | null;
  last_ingest_at: string | null;
  runner_last_seen_at: string | null;
  watermark: string | null;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function getDevToken(): string | null {
  try {
    return storage()?.getItem(DEV_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setDevToken(token: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (token) s.setItem(DEV_TOKEN_KEY, token.trim());
    else s.removeItem(DEV_TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the page then asks again.
  }
}

export async function getJson<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = getDevToken();
  if (token) headers[ACCESS_HEADER] = token;
  const res = await fetchImpl(path, { headers, credentials: "same-origin" });
  if (!res.ok) {
    let reason = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; reason?: string };
      reason = [body.error, body.reason].filter(Boolean).join(": ") || reason;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, reason);
  }
  return (await res.json()) as T;
}

export const api = {
  health: (f?: typeof fetch) => getJson<Health>("/v1/health", f),
  runs: (limit = 50, f?: typeof fetch) => getJson<{ runs: RunFull[] }>(`/api/runs?limit=${limit}&format=full`, f),
  run: (id: string, f?: typeof fetch) => getJson<{ run: RunFull; jobs: Job[] }>(`/api/runs/${encodeURIComponent(id)}`, f),
  freshness: (window = "24h", f?: typeof fetch) => getJson<Freshness>(`/api/freshness?window=${window}`, f),
  metrics: (f?: typeof fetch) => getJson<MetricsSnapshot>("/api/metrics/latest", f),
  status: (f?: typeof fetch) => getJson<Status>("/api/status", f),
};
