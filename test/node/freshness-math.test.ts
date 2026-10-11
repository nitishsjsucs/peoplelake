import { describe, expect, it } from "vitest";
import { parseWindow, summarizeFreshness, weightedPercentile } from "../../src/worker/api/freshness.ts";

// The same cases as pipeline/tests/test_freshness.py: the Worker and the eval agree on the math.
describe("freshness math (Worker side)", () => {
  it("uses nearest rank on weighted values", () => {
    const values: [number, number][] = [[10, 1], [20, 1], [30, 1], [40, 1]];
    expect(weightedPercentile(values, 0.5)).toBe(20);
    expect(weightedPercentile(values, 0.95)).toBe(40);
    expect(weightedPercentile([[5, 99], [900, 1]], 0.95)).toBe(5);
    expect(weightedPercentile([[5, 94], [900, 6]], 0.95)).toBe(900);
    expect(weightedPercentile([], 0.5)).toBeNull();
  });

  it("summarizes published buckets and counts pending ones", () => {
    const rows = [
      { run_id: "r1", bucket_start_s: 1000, events: 3, published_by: "r1", published_at: 1_899_000 },
      { run_id: "r1", bucket_start_s: 1000, events: 1, published_by: "r1", published_at: 1_901_000 },
      { run_id: "r2", bucket_start_s: 2000, events: 2, published_by: null, published_at: null },
    ];
    expect(summarizeFreshness(rows)).toMatchObject({ events: 4, pending_events: 2, p50_s: 899, max_s: 901, share_within_15m: 0.75 });
  });

  it("parses windows", () => {
    expect(parseWindow("60m")).toBe(3_600_000);
    expect(parseWindow("24h")).toBe(86_400_000);
    expect(parseWindow("7d")).toBe(604_800_000);
    expect(parseWindow("nonsense")).toBe(86_400_000);
  });
});
