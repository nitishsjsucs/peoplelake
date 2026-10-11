import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contractPath, renderContract } from "../../scripts/gen-contracts.ts";
import { CONTRACT_SCHEMAS, type ContractName } from "../../src/shared/contracts.ts";

const root = process.cwd();
const names = Object.keys(CONTRACT_SCHEMAS) as ContractName[];
const fixture = (name: string, kind: "valid" | "invalid"): unknown =>
  JSON.parse(readFileSync(join(root, "contracts", "fixtures", `${name}.${kind}.json`), "utf8"));

describe("contracts", () => {
  it.each(names)("%s JSON Schema is generated from the zod contract", (name) => {
    expect(readFileSync(contractPath(root, name), "utf8")).toBe(renderContract(name));
  });

  it.each(names)("%s valid fixture parses", (name) => {
    const result = CONTRACT_SCHEMAS[name].safeParse(fixture(name, "valid"));
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it.each(names)("%s invalid fixture is rejected", (name) => {
    expect(CONTRACT_SCHEMAS[name].safeParse(fixture(name, "invalid")).success).toBe(false);
  });

  it("source fixtures cover every event type", () => {
    const hris = fixture("source-hris", "valid") as { events: { eventType: string }[] };
    const ats = fixture("source-ats", "valid") as { records: { type: string }[] };
    const talent = fixture("source-talent", "valid") as { items: { kind: string }[] };
    expect(new Set(hris.events.map((e) => e.eventType)).size).toBe(8);
    expect(new Set(ats.records.map((e) => e.type)).size).toBe(8);
    expect(new Set(talent.items.map((e) => e.kind)).size).toBe(2);
  });
});
