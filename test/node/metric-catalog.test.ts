// SPEC 15.6, "five workforce metrics": the Worker's catalog has exactly the five (pytest
// test_metric_catalog_has_exactly_five checks the mart, the oracle seed and the semantic layer).
import { describe, expect, it } from "vitest";
import { METRIC_IDS, METRIC_LABELS } from "../../src/shared/metrics.ts";

describe("metric catalog", () => {
  it("has exactly the five workforce metrics", () => {
    expect(METRIC_IDS).toEqual(["headcount", "fte", "hires", "departures", "offer_acceptance_rate"]);
    expect(Object.keys(METRIC_LABELS)).toEqual([...METRIC_IDS]);
  });
});
