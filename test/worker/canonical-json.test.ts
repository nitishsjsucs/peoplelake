import { describe, expect, it } from "vitest";
import golden from "../../contracts/golden/canonical-json.json";
import { CanonicalJsonError, canonicalJson, compareCodePoints, sha256Hex } from "../../src/worker/ingest/canonical-json.ts";

describe("canonical JSON golden (shared with pytest)", () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const text = canonicalJson(c.value);
    expect(text).toBe(c.canonical);
    expect(await sha256Hex(text)).toBe(c.sha256);
  });

  it.each(golden.rejected.map((r) => [r.name, r.json] as const))("rejects %s", (_name, json) => {
    expect(() => canonicalJson(JSON.parse(json))).toThrow(CanonicalJsonError);
  });

  it("sorts keys by code point, not UTF-16 code unit", () => {
    expect(compareCodePoints("～", "\u{1f600}")).toBeLessThan(0);
    expect("～" < "\u{1f600}").toBe(false); // the default comparison would get this wrong
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("a", "a")).toBe(0);
  });

  it("rejects undefined, NaN and non-plain objects", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
  });
});
