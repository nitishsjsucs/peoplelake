import { describe, expect, it } from "vitest";
import { type AskReport, type DeliveryRecoveryReport, END, type FreshnessReport, type IngestCpuReport, type ParityReport, renderResults, replaceSection, type ScenarioReport, START } from "../../scripts/lib/results.ts";
import { findProseViolations } from "../../scripts/lib/prose.ts";

const scenario: ScenarioReport = {
  kind: "scenario-equivalence",
  command: "peoplelake eval scenarios --profile small",
  date: "2026-10-10",
  profile: "small",
  engine: "duckdb",
  orchestration: "local",
  lake: "local stand-in",
  passed: true,
  scenarios: [
    {
      scenario: "B",
      name: "baseline",
      passed: true,
      duration_s: 56.7,
      identical_to_reference: { a: true, b: true },
      oracle_rows_mismatched: 0,
      warn_checks_at_quiescence: { recon_metrics_vs_oracle: 0 },
      observed: { deliveries_sent: 10000, runs: 11 },
    },
  ],
};

const freshness: FreshnessReport = {
  kind: "freshness",
  command: "peoplelake eval freshness --target local --duration 60m",
  date: "2026-10-10",
  target: "local",
  method: "ledger",
  engine: "duckdb",
  profile: "full",
  events: 100000,
  duration_minutes: 60,
  overall: { p50_s: 80, p90_s: 120, p95_s: 130, p99_s: 150, max_s: 200, share_within_15m: 1 },
  excluding_first_5_minutes: { p95_s: 128 },
  runs: 70,
  stand_ins: "SqlCatalog, local runner",
};

const ingest: IngestCpuReport = {
  kind: "ingest-cpu",
  command: "npm run bench:ingest",
  date: "2026-10-11",
  method: "Worker code path in Node",
  runtime: "node v25.9.0",
  machine: "darwin arm64",
  load_average_1m: 3.1,
  iterations_per_size_and_source: 300,
  fresh_processes_per_size_and_source: 9,
  free_cpu_limit_ms: 10,
  batch_limit: 50,
  sizes: [
    { events: 50, warm_p50_ms: [0.75, 0.81], warm_p99_ms: [2.8, 3.7], first_request_fresh_ms: [7.8, 12.2], first_request_after_prewarm_ms: [2.8, 3.3], ndjson_bytes: [30720, 34816] },
  ],
};

describe("results renderer", () => {
  it("renders a resumable Workers AI ask result with its model, days, calls and neurons", () => {
    const ask: AskReport = {
      kind: "ask",
      command: "peoplelake eval ask --provider workers-ai --resume",
      date: "2026-10-13",
      provider: "workers-ai",
      provider_label: "Workers AI through AI Gateway peoplelake",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      days: ["2026-10-12", "2026-10-13"],
      calls: 63,
      neurons_estimated: 2121,
      target: "prod",
      route: "POST /api/ask/query",
      questions_file: "evals/ask/questions.jsonl",
      questions_sha256: "f6b4b0d5e154aaaa",
      summary: { questions: 60, exact_match: 50, field_accuracy: { metric: 1, department_id: 1, start_month: 0.9, end_month: 0.9 }, invalid_answers: 0, latency_ms: { p50: 900, p95: 1500 } },
    };
    const text = renderResults([{ file: "evals/results/ask-workers-ai-2026-10-13.json", report: ask }]);
    expect(text).toContain("model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`");
    expect(text).toContain("UTC days: 2026-10-12, 2026-10-13; model calls: 63; neurons reserved: 2121.");
    expect(findProseViolations(text)).toEqual([]);
  });

  it("renders the ingest CPU benchmark with ranges and the 10 ms limit", () => {
    const text = renderResults([{ file: "evals/results/ingest-cpu-2026-10-11.json", report: ingest }]);
    expect(text).toContain("#### Ingest CPU per request (2026-10-11)");
    expect(text).toContain("| 50 (the limit) | 0.75 to 0.81 | 2.8 to 3.7 | 7.8 to 12.2 | 2.8 to 3.3 | 30 to 34 KB |");
    expect(text).toContain("allows 10 ms of CPU per request");
    expect(findProseViolations(text)).toEqual([]);
    const other = renderResults([
      {
        file: "evals/results/ingest-cpu-2026-10-11.json",
        report: { ...ingest, other_paths: [{ path: "dispatch assertion (RS256)", detail: "signAssertion", warm_p99_ms: 0.81, first_call_fresh_ms: [2.05, 2.51] }] },
      },
    ]);
    expect(other).toContain("Other paths bound by the 10 ms limit");
    expect(other).toContain("| dispatch assertion (RS256) | signAssertion | 0.81 | 2.05 to 2.51 |");
    expect(other).toContain("Hono routing, Access JWT verification and Durable Object calls are not timed here");
    const withJwt = renderResults([
      {
        file: "evals/results/ingest-cpu-2026-10-11.json",
        report: { ...ingest, other_paths: [{ path: "Access JWT verification (RS256)", detail: "verifyAccessJwt", warm_p99_ms: 0.2, first_call_fresh_ms: [1.1, 1.4] }] },
      },
    ]);
    expect(withJwt).toContain("Hono routing and Durable Object calls are not timed here");
    expect(withJwt).toContain("| Access JWT verification (RS256) | verifyAccessJwt | 0.2 | 1.1 to 1.4 |");
  });

  it("renders every report with its command and date, and no dashes in prose", () => {
    const text = renderResults([
      { file: "evals/results/a.json", report: scenario },
      { file: "evals/results/b.json", report: freshness },
    ]);
    expect(text).toContain("`peoplelake eval scenarios --profile small`");
    expect(text).toContain("| B baseline | 2 | 0 | 0 | 10000 | 11 | 56.7 s |");
    expect(text).toContain("| 100000 | 60 min | 70 | 80 s | 120 s | 130 s | 150 s | 200 s | 100.00% | 128 s |");
    expect(findProseViolations(text)).toEqual([]);
  });

  it("renders the freshness split and the ops histogram cross-check when the report has them", () => {
    const text = renderResults([
      {
        file: "evals/results/f.json",
        report: {
          ...freshness,
          machine: "Darwin arm64",
          runs_committed: 70,
          transforms_skipped: 30,
          components: { receive_to_run_start: { p95_s: 100 }, run_start_to_commit: { p95_s: 25 } },
          cross_check_ops_histogram: { ledger_events: 100000, ops_events: 100000, mismatched_10s_buckets: 0, agrees: true },
          target_15_minutes_p95_met: true,
        },
      },
    ]);
    expect(text).toContain("#### Freshness, local, full profile, wide run guards (2026-10-10)");
    expect(text).toContain("p95 split: first receipt to run start 100 s, run start to commit 25 s.");
    expect(text).toContain("Runs committed: 70 of 70, transforms skipped (the load inserted nothing new): 30.");
    expect(text).toContain("100000 ledger events, 100000 ops events, 0 mismatched 10 s buckets (agrees)");
    expect(text).toContain("15-minute p95 target (reported, not asserted): met.");
    expect(findProseViolations(text)).toEqual([]);
  });

  it("says how a local freshness run was paced, and that older results ran with wide guards", () => {
    const old = renderResults([{ file: "evals/results/f.json", report: { ...freshness, delivery: { tick_seconds: 1 } } }]);
    expect(old).toContain("Run guards: not recorded in this file; the run used wrangler.jsonc's local values of the time, set wide");
    expect(old).toContain("Sources posted every 1 s (production: every 10 s).");
    const paced = renderResults([
      {
        file: "evals/results/g.json",
        report: { ...freshness, run_guards: { run_min_interval_s: 240, auto_runs_max_per_day: 30, production_values: true }, tick_seconds: 10, wall_time_s: 3725 },
      },
    ]);
    expect(paced).toContain("Run guards: 240 s minimum interval between automatic runs, 30 automatic runs a day (the production values). Sources posted every 10 s (production: every 10 s). Wall time 62 min 5 s.");
    expect(findProseViolations(paced)).toEqual([]);
  });

  it("renders delivery recovery with the injected faults, the retries and the exactly-once accounting", () => {
    const recovery: DeliveryRecoveryReport = {
      kind: "delivery-recovery",
      command: "peoplelake eval delivery-recovery --profile full",
      date: "2026-10-12",
      profile: "full",
      engine: "duckdb",
      chunks: 20,
      orchestration: "local (wrangler dev / Miniflare Workflows)",
      proxy: "HTTP proxy on a Unix socket",
      machine: "Darwin arm64",
      duration_s: 130.4,
      retry_policy: { max_attempts: 10, base_delay_s: 0.5, max_delay_s: 30, max_retry_after_s: 120, budget_s: 600 },
      planned_requests: 2063,
      proxy_ingest_requests: 2077,
      faults_by_kind: { drop: 2, error_500: 5, backpressure_503: 2, lost_answer: 3, error_500_after_landing: 2 },
      landed_then_failed_records: 250,
      delivery: { deliveries_sent: 100000, requests_sent: 2063, attempts: 2077, retries: 14, retry_reasons: { http_500: 7 }, possible_duplicate_deliveries: 600 },
      warehouse: { raw_deliveries: 100250, unique_events: 100000, duplicate_deliveries_in_raw: 250, stg_events_rows: 100000, stg_events_unique: 100000, freshness_ledger_events: 100000, runs: 21, runs_committed: 21 },
      identical_to_reference: { a: true, b: true },
      oracle_rows_mismatched: 0,
      warn_checks_at_quiescence: { w: 0 },
      checks: { scenario_checks_pass: true, every_fault_fired: true },
      passed: true,
    };
    const text = renderResults([{ file: "evals/results/delivery-recovery-full-duckdb-2026-10-12.json", report: recovery }]);
    expect(text).toContain("#### Delivery recovery, full profile, duckdb (2026-10-12)");
    expect(text).toContain("failed 14 of the 2077 ingest requests it carried on purpose");
    expect(text).toContain("connection dropped before the Worker 2, 500 before the Worker 5, 503 landing_backpressure 2, landed then the answer lost 3, landed then 500 2");
    expect(text).toContain("at most 10 attempts per batch and no sleep past 600 s from the first attempt");
    expect(text).toContain("| 14 | 14 | 2063 | 100000 | 250 | 250 | 600 | 100000 | 100000 | 2 | 0 | 0 |");
    expect(text).toContain("Checks passed: 2 of 2. Recovered with every event in the warehouse exactly once: **yes**.");
    expect(findProseViolations(text)).toEqual([]);
    const failed = renderResults([{ file: "evals/results/r.json", report: { ...recovery, passed: false, checks: { every_fault_fired: false, scenario_checks_pass: true } } }]);
    expect(failed).toContain("Checks passed: 1 of 2 (failed: every_fault_fired). Recovered with every event in the warehouse exactly once: **no**.");
  });

  it("says how many retries a freshness delivery needed when the result records them", () => {
    const retried = renderResults([
      {
        file: "evals/results/f.json",
        report: { ...freshness, delivery: { tick_seconds: 10, attempts: 2518, retries: 2, retry_reasons: { http_500: 1, "transport:RemoteProtocolError": 1 }, possible_duplicate_deliveries: 100 } },
      },
    ]);
    expect(retried).toContain("Source retries: 2 in 2518 HTTP attempts (http_500 1, transport:RemoteProtocolError 1), at most 100 duplicate deliveries, which the warehouse merges.");
    const none = renderResults([{ file: "evals/results/f.json", report: { ...freshness, delivery: { tick_seconds: 10, attempts: 2516, retries: 0, retry_reasons: {}, possible_duplicate_deliveries: 0 } } }]);
    expect(none).toContain("Source retries: none in 2516 HTTP attempts.");
    expect(renderResults([{ file: "evals/results/f.json", report: freshness }])).not.toContain("Source retries");
  });

  it("renders the production ledger coverage", () => {
    const text = renderResults([
      {
        file: "evals/results/p.json",
        report: { ...freshness, target: "prod", ledger_coverage: { delivered_unique_events: 100000, ledger_published_events: 100000, complete: true } },
      },
    ]);
    expect(text).toContain("Ledger coverage: 100000 of 100000 delivered unique events published (complete).");
  });

  it("renders ask accuracy with the provider, model, questions hash and per-field accuracy", () => {
    const ask: AskReport = {
      kind: "ask",
      command: "peoplelake eval ask --provider llama",
      date: "2026-10-11",
      provider: "llama",
      provider_label: "llama-server on 127.0.0.1:8150 (local stand-in for Workers AI)",
      model: "Qwen3-1.7B-Q4_0-rtn.gguf",
      target: "local",
      route: "POST /api/ask/query",
      questions_file: "evals/ask/questions.jsonl",
      questions_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      machine: "Darwin arm64",
      summary: {
        questions: 60,
        exact_match: 45,
        field_accuracy: { metric: 0.95, department_id: 0.9, start_month: 0.85, end_month: 0.8 },
        invalid_answers: 1,
        latency_ms: { p50: 1234.4, p95: 2100.6 },
      },
    };
    const text = renderResults([{ file: "evals/results/ask-llama-2026-10-11.json", report: ask }]);
    expect(text).toContain("#### Ask accuracy, llama (2026-10-11)");
    expect(text).toContain("model `Qwen3-1.7B-Q4_0-rtn.gguf`");
    expect(text).toContain("(sha256 `0123456789ab`)");
    expect(text).toContain("| 60 | 45 (75.0%) | 95.0% | 90.0% | 85.0% | 80.0% | 1 | 1234 ms | 2101 ms |");
    expect(findProseViolations(text)).toEqual([]);
  });

  it("renders MetricFlow parity with the rows compared and the rows that differ", () => {
    const parity: ParityReport = {
      kind: "metricflow-parity",
      command: "peoplelake dev metricflow-parity --profile small",
      date: "2026-10-11",
      profile: "small",
      engine: "duckdb",
      semantic_layer: "MetricFlow planning DuckDB SQL",
      mart: "peoplelake_core.metrics_workforce_monthly",
      metrics: ["headcount", "fte"],
      events_loaded: 10000,
      rows_compared: 468,
      mismatched_rows: 0,
      passed: true,
    };
    const text = renderResults([{ file: "evals/results/metricflow-parity-small-2026-10-11.json", report: parity }]);
    expect(text).toContain("#### MetricFlow parity, small profile, duckdb (2026-10-11)");
    expect(text).toContain("| headcount, fte | 468 | 0 | yes |");
    expect(findProseViolations(text)).toEqual([]);
  });

  it("says so when there are no results and replaces only the marked section", () => {
    const readme = `# x\n\n## Results\n\n${START}\nold\n${END}\n\n## License\n`;
    const out = replaceSection(readme, renderResults([]));
    expect(out).toContain("No results recorded yet.");
    expect(out).not.toContain("old");
    expect(out).toContain("## License");
    expect(() => replaceSection("no markers", "x")).toThrow();
  });
});
