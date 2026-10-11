// Pure formatting and chart helpers (unit tested in test/web).
import type { Checks, MetricsRow, RunSummary } from "./api.ts";

export const METRICS = [
  { id: "headcount", label: "Headcount", hint: "active at month end" },
  { id: "fte", label: "FTE", hint: "full-time equivalents at month end" },
  { id: "hires", label: "Hires", hint: "hires and rehires in the month" },
  { id: "departures", label: "Departures", hint: "effective terminations in the month" },
  { id: "offer_acceptance_rate", label: "Offer acceptance", hint: "accepted / (accepted + declined) by decision month" },
] as const;
export type MetricKey = (typeof METRICS)[number]["id"];

export const DEPARTMENTS: Record<string, string> = {
  ALL: "Whole company",
  D01: "Engineering",
  D02: "Product",
  D03: "Design",
  D04: "Sales",
  D05: "Marketing",
  D06: "Customer Success",
  D07: "Finance",
  D08: "People",
  D09: "Legal",
  D10: "Operations",
  D11: "Data",
  D12: "Security",
};

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (value < 120) return `${value} s`;
  const m = Math.floor(value / 60);
  const s = value % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export function share(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function timestamp(ms: number | null | undefined): string {
  if (!ms) return "n/a";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function duration(startMs: number | null | undefined, endMs: number | null | undefined): string {
  if (!startMs || !endMs || endMs < startMs) return "n/a";
  return seconds(Math.round((endMs - startMs) / 1000));
}

/** Metric values arrive as canonical decimal strings ("0.833333", "4650"); show them compactly. */
export function metricValue(metric: MetricKey, raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "n/a";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (metric === "offer_acceptance_rate") return `${(n * 100).toFixed(1)}%`;
  if (metric === "fte") return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return n.toLocaleString("en-US");
}

export function monthLabel(month: string): string {
  return month.slice(0, 7);
}

export function rowsFor(rows: MetricsRow[], departmentId: string): MetricsRow[] {
  return rows.filter((r) => r.department_id === departmentId).sort((a, b) => a.month.localeCompare(b.month));
}

export function checkTotals(checks: Checks | null): { error: number; warn: number } {
  if (!checks) return { error: 0, warn: 0 };
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return { error: sum(checks.error), warn: sum(checks.warn) };
}

export function runOutcome(run: RunSummary): string {
  if (run.status === "committed") return run.transform_skipped ? "committed (no new data)" : "committed";
  return run.status;
}

export interface ChartPoint {
  x: number;
  y: number;
  label: string;
  value: number;
}

/**
 * Scales a series into an SVG box (y grows downward). Null values are skipped, so a gap in the
 * series (for example a rate with no decided offers) leaves no point rather than a zero.
 */
export function chartPoints(
  series: { label: string; value: number | null }[],
  box: { width: number; height: number; padX: number; padY: number },
): { points: ChartPoint[]; min: number; max: number } {
  const present = series.filter((p): p is { label: string; value: number } => p.value !== null && Number.isFinite(p.value));
  if (present.length === 0) return { points: [], min: 0, max: 0 };
  const values = present.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const innerW = box.width - 2 * box.padX;
  const innerH = box.height - 2 * box.padY;
  const step = series.length > 1 ? innerW / (series.length - 1) : 0;
  const points: ChartPoint[] = [];
  series.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) return;
    const x = box.padX + i * step;
    const y = box.padY + innerH - ((p.value - min) / (max - min)) * innerH;
    points.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label: p.label, value: p.value });
  });
  return { points, min, max };
}

export function pathOf(points: ChartPoint[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}
