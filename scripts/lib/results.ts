// Renders evals/results/*.json into the README Results section. Only numbers produced by this repo's
// eval commands appear there, each with its command, date, engine and stand-ins.
export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

interface ScenarioResult {
  scenario: string;
  name: string;
  passed: boolean;
  duration_s: number;
  identical_to_reference: Record<string, boolean>;
  oracle_rows_mismatched: number;
  warn_checks_at_quiescence: Record<string, number>;
  observed: Record<string, unknown>;
  rebuild?: { point_in_time_identical_to_recorded?: boolean };
}

export interface ScenarioReport {
  kind: "scenario-equivalence";
  command: string;
  date: string;
  profile: string;
  engine: string;
  orchestration: string;
  lake: string;
  machine?: string;
  passed: boolean;
  scenarios: ScenarioResult[];
}

export interface FreshnessReport {
  kind: "freshness";
  command: string;
  date: string;
  target: string;
  method: string;
  engine: string;
  profile: string;
  events: number;
  duration_minutes: number;
  overall: { p50_s: number | null; p90_s: number | null; p95_s: number | null; p99_s: number | null; max_s: number | null; share_within_15m: number | null };
  excluding_first_5_minutes?: { p95_s: number | null };
  runs: number;
  stand_ins: string;
  machine?: string;
  rate_events_per_s?: number;
  runs_committed?: number;
  transforms_skipped?: number;
  components?: { receive_to_run_start: { p95_s: number | null }; run_start_to_commit: { p95_s: number | null } };
  cross_check_ops_histogram?: { ledger_events: number; ops_events: number; mismatched_10s_buckets: number; agrees: boolean };
  /** Production: the ledger must hold every delivered unique event, or no percentiles are reported. */
  ledger_coverage?: { delivered_unique_events: number; ledger_published_events: number; complete: boolean };
  target_15_minutes_p95_met?: boolean;
  /** Local runs: the Coordinator's automatic-run guards and the sources' post interval in effect. */
  run_guards?: { run_min_interval_s: number; auto_runs_max_per_day: number; production_values: boolean };
  tick_seconds?: number;
  /** The sources' delivery; results recorded after the retries landed (SPEC 29.4.1 item 11) carry the retry counters. */
  delivery?: { tick_seconds?: number | null; attempts?: number; retries?: number; retry_reasons?: Record<string, number>; possible_duplicate_deliveries?: number };
  wall_time_s?: number;
}

/** What a freshness delivery's retries cost, when the result records them (older results do not). */
export function deliveryRetries(r: FreshnessReport): string | null {
  const d = r.delivery;
  if (d?.retries === undefined || d.attempts === undefined) return null;
  if (d.retries === 0) return `Source retries: none in ${d.attempts} HTTP attempts.`;
  const reasons = Object.entries(d.retry_reasons ?? {})
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return `Source retries: ${d.retries} in ${d.attempts} HTTP attempts (${reasons}), at most ${d.possible_duplicate_deliveries ?? 0} duplicate deliveries, which the warehouse merges.`;
}

/** How a freshness run was paced: the run guards and the sources' post interval (older local results did
 * not record the guards; they ran with wrangler.jsonc's local values of the time). */
export function freshnessCadence(r: FreshnessReport): string | null {
  if (r.target !== "local") return null;
  const tick = r.tick_seconds ?? r.delivery?.tick_seconds ?? null;
  const posts = tick === null ? "" : ` Sources posted every ${tick} s (production: every 10 s).`;
  if (!r.run_guards) {
    return `Run guards: not recorded in this file; the run used wrangler.jsonc's local values of the time, set wide (no minimum interval between automatic runs, 100,000 automatic runs a day), not the production 240 s and 30.${posts}`;
  }
  const g = r.run_guards;
  return `Run guards: ${g.run_min_interval_s} s minimum interval between automatic runs, ${g.auto_runs_max_per_day.toLocaleString("en-US")} automatic runs a day (${g.production_values ? "the production values" : "set wide, not the production 240 s and 30"}).${posts}${r.wall_time_s !== undefined ? ` Wall time ${Math.floor(r.wall_time_s / 60)} min ${Math.round(r.wall_time_s % 60)} s.` : ""}`;
}

export interface AskReport {
  kind: "ask";
  command: string;
  date: string;
  provider: string;
  provider_label: string;
  model: string | null;
  /** workers-ai: the UTC days the resumable run used, the model calls and the neurons reserved. */
  days?: string[];
  calls?: number;
  neurons_estimated?: number;
  target: string;
  route: string;
  questions_file: string;
  questions_sha256: string;
  machine?: string;
  summary: {
    questions: number;
    exact_match: number;
    field_accuracy: { metric: number | null; department_id: number | null; start_month: number | null; end_month: number | null };
    invalid_answers: number;
    latency_ms: { p50: number | null; p95: number | null };
  };
}

export interface ParityReport {
  kind: "metricflow-parity";
  command: string;
  date: string;
  profile: string;
  engine: string;
  semantic_layer: string;
  mart: string;
  metrics: string[];
  events_loaded: number;
  rows_compared: number;
  mismatched_rows: number;
  passed: boolean;
  machine?: string;
}

export interface IngestCpuReport {
  kind: "ingest-cpu";
  command: string;
  date: string;
  method: string;
  runtime: string;
  machine: string;
  load_average_1m?: number;
  iterations_per_size_and_source: number;
  fresh_processes_per_size_and_source: number;
  free_cpu_limit_ms: number;
  batch_limit: number;
  sizes: {
    events: number;
    warm_p50_ms: [number, number];
    warm_p99_ms: [number, number];
    first_request_fresh_ms: [number, number];
    first_request_after_prewarm_ms: [number, number];
    ndjson_bytes: [number, number];
  }[];
  /** Other paths bound by 10 ms of CPU (a request or a Workflow step), when the result has them. */
  other_paths?: { path: string; detail: string; warm_p99_ms: number; first_call_fresh_ms: [number, number] }[];
}

export interface DeliveryRecoveryReport {
  kind: "delivery-recovery";
  command: string;
  date: string;
  profile: string;
  engine: string;
  chunks: number;
  orchestration: string;
  proxy: string;
  machine?: string;
  duration_s: number;
  retry_policy: { max_attempts: number; base_delay_s: number; max_delay_s: number; max_retry_after_s: number; budget_s: number };
  planned_requests: number;
  proxy_ingest_requests: number;
  faults_by_kind: Record<string, number>;
  landed_then_failed_records: number;
  delivery: { deliveries_sent: number; requests_sent: number; attempts: number; retries: number; retry_reasons: Record<string, number>; possible_duplicate_deliveries: number };
  warehouse: {
    raw_deliveries: number;
    unique_events: number;
    duplicate_deliveries_in_raw: number;
    stg_events_rows: number;
    stg_events_unique: number;
    freshness_ledger_events: number;
    runs: number;
    runs_committed: number;
  };
  identical_to_reference: Record<string, boolean>;
  oracle_rows_mismatched: number;
  warn_checks_at_quiescence: Record<string, number>;
  checks: Record<string, boolean>;
  passed: boolean;
}

export type Report = ScenarioReport | FreshnessReport | AskReport | ParityReport | IngestCpuReport | DeliveryRecoveryReport;

export const REPORT_KINDS: readonly Report["kind"][] = ["scenario-equivalence", "freshness", "ask", "metricflow-parity", "ingest-cpu", "delivery-recovery"];

const fmtS = (s: number | null | undefined): string => (s === null || s === undefined ? "n/a" : `${s} s`);

export function renderScenarioReport(r: ScenarioReport, file: string): string {
  const lines = [
    `#### Scenario equivalence, ${r.profile} profile, ${r.engine} (${r.date})`,
    "",
    `Command: \`${r.command}\` (the reference digests come from \`peoplelake dev reference-digests --profile ${r.profile}\`). Orchestration: ${r.orchestration}. Lake: ${r.lake}.${r.machine ? ` Machine: ${r.machine}.` : ""} Source: \`${file}\`.`,
    "",
    "| Scenario | Identical models (of 10) | Oracle rows mismatched | Warn checks at quiescence | Deliveries | Runs | Duration |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of r.scenarios) {
    const identical = Object.values(s.identical_to_reference).filter(Boolean).length;
    const warn = Object.values(s.warn_checks_at_quiescence).reduce((a, b) => a + b, 0);
    lines.push(
      `| ${s.scenario} ${s.name}${s.passed ? "" : " (FAILED)"} | ${identical} | ${s.oracle_rows_mismatched} | ${warn} | ${String(s.observed["deliveries_sent"] ?? "")} | ${String(s.observed["runs"] ?? "")} | ${s.duration_s} s |`,
    );
  }
  lines.push("", `All scenarios identical to the reference digests: **${r.passed ? "yes" : "no"}**.`);
  return lines.join("\n");
}

export function renderFreshnessReport(r: FreshnessReport, file: string): string {
  const o = r.overall;
  const details: string[] = [];
  const cadence = freshnessCadence(r);
  if (cadence) details.push(cadence);
  if (r.components) {
    details.push(`p95 split: first receipt to run start ${fmtS(r.components.receive_to_run_start.p95_s)}, run start to commit ${fmtS(r.components.run_start_to_commit.p95_s)}.`);
  }
  if (r.runs_committed !== undefined) {
    details.push(`Runs committed: ${r.runs_committed} of ${r.runs}${r.transforms_skipped !== undefined ? `, transforms skipped (the load inserted nothing new): ${r.transforms_skipped}` : ""}.`);
  }
  if (r.cross_check_ops_histogram) {
    const x = r.cross_check_ops_histogram;
    details.push(`Cross-check against the runner's \`ops_event_freshness\` histograms: ${x.ledger_events} ledger events, ${x.ops_events} ops events, ${x.mismatched_10s_buckets} mismatched 10 s buckets (${x.agrees ? "agrees" : "DISAGREES"}).`);
  }
  if (r.ledger_coverage) {
    const c = r.ledger_coverage;
    details.push(`Ledger coverage: ${c.ledger_published_events} of ${c.delivered_unique_events} delivered unique events published (${c.complete ? "complete" : "INCOMPLETE"}).`);
  }
  const retries = deliveryRetries(r);
  if (retries) details.push(retries);
  if (r.target_15_minutes_p95_met !== undefined) details.push(`15-minute p95 target (reported, not asserted): ${r.target_15_minutes_p95_met ? "met" : "not met"}.`);
  return [
    `#### Freshness, ${r.target}, ${r.profile} profile${r.target === "local" ? (r.run_guards?.production_values ? ", production run guards" : ", wide run guards") : ""} (${r.date})`,
    "",
    `Command: \`${r.command}\`. Method: ${r.method}. Engine: ${r.engine}. Stand-ins: ${r.stand_ins}${r.target === "local" && !r.stand_ins.includes("Miniflare") ? "; and wrangler dev (Miniflare Workers, Durable Objects, R2, Queue and Workflows)" : ""}.${r.machine ? ` Machine: ${r.machine}.` : ""}${r.rate_events_per_s !== undefined ? ` Rate: ${r.rate_events_per_s} events per second.` : ""} Source: \`${file}\`.`,
    "",
    "| Events | Duration | Runs | p50 | p90 | p95 | p99 | max | Within 15 min | p95 excluding first 5 min |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${r.events} | ${r.duration_minutes} min | ${r.runs} | ${fmtS(o.p50_s)} | ${fmtS(o.p90_s)} | ${fmtS(o.p95_s)} | ${fmtS(o.p99_s)} | ${fmtS(o.max_s)} | ${o.share_within_15m === null ? "n/a" : `${(o.share_within_15m * 100).toFixed(2)}%`} | ${fmtS(r.excluding_first_5_minutes?.p95_s)} |`,
    ...(details.length ? ["", details.join(" ")] : []),
  ].join("\n");
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const ms = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x)} ms`);

export function renderAskReport(r: AskReport, file: string): string {
  const s = r.summary;
  const f = s.field_accuracy;
  return [
    `#### Ask accuracy, ${r.provider} (${r.date})`,
    "",
    `Command: \`${r.command}\`. Provider: ${r.provider_label}${r.model ? `, model \`${r.model}\`` : ""}. Target: ${r.target}, route \`${r.route}\`. Questions: \`${r.questions_file}\` (sha256 \`${r.questions_sha256.slice(0, 12)}\`).${r.days ? ` UTC days: ${r.days.join(", ")}; model calls: ${r.calls ?? "n/a"}; neurons reserved: ${r.neurons_estimated ?? "n/a"}.` : ""}${r.machine ? ` Machine: ${r.machine}.` : ""} Source: \`${file}\`.`,
    "",
    "| Questions | Exact match | Metric | Department | Start month | End month | Invalid answers | Latency p50 | Latency p95 |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${s.questions} | ${s.exact_match} (${pct(s.questions ? s.exact_match / s.questions : null)}) | ${pct(f.metric)} | ${pct(f.department_id)} | ${pct(f.start_month)} | ${pct(f.end_month)} | ${s.invalid_answers} | ${ms(s.latency_ms.p50)} | ${ms(s.latency_ms.p95)} |`,
  ].join("\n");
}

export function renderParityReport(r: ParityReport, file: string): string {
  return [
    `#### MetricFlow parity, ${r.profile} profile, ${r.engine} (${r.date})`,
    "",
    `Command: \`${r.command}\`. Semantic layer: ${r.semantic_layer}, compared with \`${r.mart}\` after a straight load of ${r.events_loaded} events.${r.machine ? ` Machine: ${r.machine}.` : ""} Source: \`${file}\`.`,
    "",
    "| Metrics | Rows compared (months x departments and ALL) | Rows that differ | Identical |",
    "|---|---:|---:|---|",
    `| ${r.metrics.join(", ")} | ${r.rows_compared} | ${r.mismatched_rows} | ${r.passed ? "yes" : "no"} |`,
  ].join("\n");
}

const span = ([a, b]: [number, number], unit = ""): string => (a === b ? `${a}${unit}` : `${a} to ${b}${unit}`);

export function renderIngestCpuReport(r: IngestCpuReport, file: string): string {
  const rows = r.sizes.map(
    (s) =>
      `| ${s.events}${s.events === r.batch_limit ? " (the limit)" : ""} | ${span(s.warm_p50_ms)} | ${span(s.warm_p99_ms)} | ${span(s.first_request_fresh_ms)} | ${span(s.first_request_after_prewarm_ms)} | ${span([Math.round(s.ndjson_bytes[0] / 1024), Math.round(s.ndjson_bytes[1] / 1024)], " KB")} |`,
  );
  return [
    `#### Ingest CPU per request (${r.date})`,
    "",
    `Command: \`${r.command}\`. Method: ${r.method}. Runtime: ${r.runtime}. Machine: ${r.machine}${r.load_average_1m !== undefined ? ` (load average ${r.load_average_1m})` : ""}. ${r.iterations_per_size_and_source} warm requests and ${r.fresh_processes_per_size_and_source} fresh processes per size and source; ranges are across the three sources. The Workers Free plan allows ${r.free_cpu_limit_ms} ms of CPU per request; the Worker accepts at most ${r.batch_limit} events. Source: \`${file}\`.`,
    "",
    "| Events per request | Warm p50 (ms) | Warm p99 (ms) | First request, fresh process (ms) | First request after prewarm (ms) | NDJSON per request |",
    "|---:|---|---|---|---|---|",
    ...rows,
    ...(r.other_paths?.length
      ? [
          "",
          `Other paths bound by the 10 ms limit (same method; ${r.other_paths.some((o) => o.path.startsWith("Access JWT")) ? "Hono routing and Durable Object calls are" : "Hono routing, Access JWT verification and Durable Object calls are"} not timed here):`,
          "",
          "| Path | What is timed | Warm p99 (ms) | First call, fresh process (ms) |",
          "|---|---|---:|---|",
          ...r.other_paths.map((o) => `| ${o.path} | ${o.detail} | ${o.warm_p99_ms} | ${span(o.first_call_fresh_ms)} |`),
        ]
      : []),
  ].join("\n");
}

const FAULT_LABELS: Record<string, string> = {
  drop: "connection dropped before the Worker",
  error_500: "500 before the Worker",
  backpressure_503: "503 landing_backpressure",
  lost_answer: "landed then the answer lost",
  error_500_after_landing: "landed then 500",
};

export function renderDeliveryRecoveryReport(r: DeliveryRecoveryReport, file: string): string {
  const injected = Object.values(r.faults_by_kind).reduce((a, b) => a + b, 0);
  const kinds = Object.entries(r.faults_by_kind)
    .map(([k, n]) => `${FAULT_LABELS[k] ?? k} ${n}`)
    .join(", ");
  const p = r.retry_policy;
  const d = r.delivery;
  const w = r.warehouse;
  const identical = Object.values(r.identical_to_reference).filter(Boolean).length;
  const warn = Object.values(r.warn_checks_at_quiescence).reduce((a, b) => a + b, 0);
  const failed = Object.entries(r.checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return [
    `#### Delivery recovery, ${r.profile} profile, ${r.engine} (${r.date})`,
    "",
    `Command: \`${r.command}\`. The baseline delivery (B, ${r.chunks} chunks) went through the fault proxy (an HTTP proxy on a Unix socket between the source clients and wrangler dev, \`pipeline/src/peoplelake/evals/delivery_recovery.py\`), which failed ${injected} of the ${r.proxy_ingest_requests} ingest requests it carried on purpose: ${kinds}. Retry policy: at most ${p.max_attempts} attempts per batch and no sleep past ${p.budget_s} s from the first attempt, backoff ${p.base_delay_s} s doubling to ${p.max_delay_s} s with jitter, Retry-After honored up to ${p.max_retry_after_s} s. "Landed, then failed" counts the records of requests the Worker accepted before the proxy failed the answer; the client's bound is its \`possible_duplicate_deliveries\`. Orchestration: ${r.orchestration}.${r.machine ? ` Machine: ${r.machine}.` : ""} Duration ${r.duration_s} s. Source: \`${file}\`.`,
    "",
    "| Faults injected | Retries | Batches accepted | Events accepted | Landed, then failed | Duplicate deliveries in raw | Client's bound | Events in stg_events | Freshness ledger events | Identical models (of 10) | Oracle rows mismatched | Warn checks |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${injected} | ${d.retries} | ${d.requests_sent} | ${d.deliveries_sent} | ${r.landed_then_failed_records} | ${w.duplicate_deliveries_in_raw} | ${d.possible_duplicate_deliveries} | ${w.stg_events_rows} | ${w.freshness_ledger_events} | ${identical} | ${r.oracle_rows_mismatched} | ${warn} |`,
    "",
    `Checks passed: ${Object.keys(r.checks).length - failed.length} of ${Object.keys(r.checks).length}${failed.length ? ` (failed: ${failed.join(", ")})` : ""}. Recovered with every event in the warehouse exactly once: **${r.passed ? "yes" : "no"}**.`,
  ].join("\n");
}

function renderReport(report: Report, file: string): string {
  switch (report.kind) {
    case "delivery-recovery":
      return renderDeliveryRecoveryReport(report, file);
    case "ingest-cpu":
      return renderIngestCpuReport(report, file);
    case "metricflow-parity":
      return renderParityReport(report, file);
    case "freshness":
      return renderFreshnessReport(report, file);
    case "ask":
      return renderAskReport(report, file);
    default:
      return renderScenarioReport(report, file);
  }
}

export function renderResults(reports: { file: string; report: Report }[]): string {
  const sorted = [...reports].sort((a, b) => a.file.localeCompare(b.file));
  const parts = [
    "Rendered by `npm run results:readme` from `evals/results/*.json`. Every number below was produced by the command shown, on the date shown, with the engine and stand-ins named; nothing is estimated.",
  ];
  if (sorted.length === 0) parts.push("", "No results recorded yet.");
  for (const { file, report } of sorted) {
    parts.push("", renderReport(report, file));
  }
  return parts.join("\n");
}

export function replaceSection(readme: string, body: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error("README has no results markers");
  return `${readme.slice(0, start + START.length)}\n${body}\n${readme.slice(end)}`;
}
