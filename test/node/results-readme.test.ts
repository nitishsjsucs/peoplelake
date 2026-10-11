import { describe, expect, it } from "vitest";
import { type AskReport, END, type FreshnessReport, type IngestCpuReport, type ParityReport, renderResults, replaceSection, type ScenarioReport, START } from "../../scripts/lib/results.ts";
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
    expect(text).toContain("#### Freshness, local, full profile (2026-10-10)");
    expect(text).toContain("p95 split: first receipt to run start 100 s, run start to commit 25 s.");
    expect(text).toContain("Runs committed: 70 of 70, transforms skipped (the load inserted nothing new): 30.");
    expect(text).toContain("100000 ledger events, 100000 ops events, 0 mismatched 10 s buckets (agrees)");
    expect(text).toContain("15-minute p95 target (reported, not asserted): met.");
    expect(findProseViolations(text)).toEqual([]);
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
