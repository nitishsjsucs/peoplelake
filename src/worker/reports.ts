// R2 report writers (REPORTS_BUCKET). Keys are deterministic, so a retried commit step overwrites harmlessly.
export const LATEST_METRICS_KEY = "reports/metrics/latest.json";

export function metricsKey(runId: string): string {
  return `reports/metrics/${runId}.json`;
}

export function runReportKey(runId: string): string {
  return `reports/runs/${runId}.json`;
}

export async function writeRunReport(env: Env, runId: string, report: unknown): Promise<void> {
  await env.REPORTS_BUCKET.put(runReportKey(runId), JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function publishLatestMetrics(env: Env, key: string): Promise<void> {
  const obj = await env.REPORTS_BUCKET.get(key);
  if (obj === null) throw new Error(`metrics artifact ${key} not found`);
  await env.REPORTS_BUCKET.put(LATEST_METRICS_KEY, await obj.text(), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { source_key: key },
  });
}
