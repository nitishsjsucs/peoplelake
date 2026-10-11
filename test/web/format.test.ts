import { describe, expect, it } from "vitest";
import { parseRoute } from "../../web/src/App.tsx";
import { chartPoints, checkTotals, duration, metricValue, pathOf, rowsFor, seconds, share } from "../../web/src/format.ts";
import type { MetricsRow } from "../../web/src/api.ts";

describe("formatting", () => {
  it("formats seconds, shares and durations", () => {
    expect(seconds(78)).toBe("78 s");
    expect(seconds(900)).toBe("15 min");
    expect(seconds(125)).toBe("2 min 5 s");
    expect(seconds(null)).toBe("n/a");
    expect(share(1)).toBe("100.0%");
    expect(share(0.83333)).toBe("83.3%");
    expect(duration(1_000, 23_000)).toBe("22 s");
    expect(duration(null, 5)).toBe("n/a");
  });

  it("formats metric values from canonical decimal strings", () => {
    expect(metricValue("headcount", "4650")).toBe("4,650");
    expect(metricValue("fte", "4512.400000")).toBe("4,512.4");
    expect(metricValue("offer_acceptance_rate", "0.833333")).toBe("83.3%");
    expect(metricValue("hires", null)).toBe("n/a");
  });

  it("sums error and warn checks", () => {
    expect(checkTotals({ error: { r1: 0, r3: 2 }, warn: { r10: 5, r7: 1 } })).toEqual({ error: 2, warn: 6 });
    expect(checkTotals(null)).toEqual({ error: 0, warn: 0 });
  });

  it("parses hash routes", () => {
    expect(parseRoute("")).toEqual({ page: "overview" });
    expect(parseRoute("#/runs")).toEqual({ page: "runs" });
    expect(parseRoute("#/runs/r-abc-000001")).toEqual({ page: "run", runId: "r-abc-000001" });
    expect(parseRoute("#/metrics")).toEqual({ page: "metrics" });
    expect(parseRoute("#/checks")).toEqual({ page: "checks" });
    expect(parseRoute("#/nope")).toEqual({ page: "overview" });
  });

  it("selects one department's rows in month order", () => {
    const row = (month: string, department_id: string) => ({ month, department_id }) as MetricsRow;
    const rows = [row("2023-02-28", "ALL"), row("2023-01-31", "D01"), row("2023-01-31", "ALL")];
    expect(rowsFor(rows, "ALL").map((r) => r.month)).toEqual(["2023-01-31", "2023-02-28"]);
  });
});

describe("chart scaling", () => {
  const box = { width: 100, height: 50, padX: 10, padY: 5 };

  it("maps the minimum to the bottom and the maximum to the top", () => {
    const { points, min, max } = chartPoints(
      [
        { label: "a", value: 10 },
        { label: "b", value: 20 },
        { label: "c", value: 15 },
      ],
      box,
    );
    expect([min, max]).toEqual([10, 20]);
    expect(points.map((p) => [p.x, p.y])).toEqual([
      [10, 45],
      [50, 5],
      [90, 25],
    ]);
    expect(pathOf(points)).toBe("M10,45 L50,5 L90,25");
  });

  it("skips nulls without collapsing the x positions, and widens a flat series", () => {
    const { points, min, max } = chartPoints(
      [
        { label: "a", value: 7 },
        { label: "b", value: null },
        { label: "c", value: 7 },
      ],
      box,
    );
    expect(points.map((p) => p.label)).toEqual(["a", "c"]);
    expect(points.map((p) => p.x)).toEqual([10, 90]);
    expect([min, max]).toEqual([6, 8]);
    expect(chartPoints([{ label: "a", value: null }], box).points).toEqual([]);
  });
});
