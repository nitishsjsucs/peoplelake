import { describe, expect, it } from "vitest";
import { END, type FreshnessReport, renderResults, replaceSection, type ScenarioReport, START } from "../../scripts/lib/results.ts";
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
  stand_ins: "SinkRoller, SqlCatalog",
};

describe("results renderer", () => {
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

  it("says so when there are no results and replaces only the marked section", () => {
    const readme = `# x\n\n## Results\n\n${START}\nold\n${END}\n\n## License\n`;
    const out = replaceSection(readme, renderResults([]));
    expect(out).toContain("No results recorded yet.");
    expect(out).not.toContain("old");
    expect(out).toContain("## License");
    expect(() => replaceSection("no markers", "x")).toThrow();
  });
});
