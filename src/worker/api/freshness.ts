// Freshness from the ledger: per unique event, published_at of the run that published it minus its
// first receipt (10 s histogram buckets, so values are conservative by up to 10 s).
export interface FreshnessRow {
  run_id: string;
  bucket_start_s: number;
  events: number;
  published_by: string | null;
  published_at: number | null;
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

export function weightedPercentile(values: [number, number][], p: number): number | null {
  const total = values.reduce((a, [, w]) => a + w, 0);
  if (total === 0) return null;
  const sorted = [...values].sort((a, b) => a[0] - b[0]);
  const target = p * total;
  let cumulative = 0;
  for (const [v, w] of sorted) {
    cumulative += w;
    if (cumulative >= target) return v;
  }
  return sorted[sorted.length - 1]?.[0] ?? null;
}

export function summarizeFreshness(rows: FreshnessRow[]): FreshnessSummary {
  const values: [number, number][] = [];
  let pending = 0;
  for (const r of rows) {
    if (r.published_at === null) {
      pending += r.events;
      continue;
    }
    values.push([Math.max(0, Math.round(r.published_at / 1000) - r.bucket_start_s), r.events]);
  }
  const events = values.reduce((a, [, w]) => a + w, 0);
  const within = values.filter(([v]) => v <= 900).reduce((a, [, w]) => a + w, 0);
  return {
    events,
    pending_events: pending,
    p50_s: weightedPercentile(values, 0.5),
    p90_s: weightedPercentile(values, 0.9),
    p95_s: weightedPercentile(values, 0.95),
    p99_s: weightedPercentile(values, 0.99),
    max_s: values.length ? Math.max(...values.map(([v]) => v)) : null,
    share_within_15m: events ? Math.round((within / events) * 1_000_000) / 1_000_000 : null,
  };
}

export function parseWindow(value: string | undefined): number {
  const m = /^(\d+)(m|h|d)$/.exec(value ?? "24h");
  if (!m) return 24 * 3600 * 1000;
  const n = Number(m[1]);
  return n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}
