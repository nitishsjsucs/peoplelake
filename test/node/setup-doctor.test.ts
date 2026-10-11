import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { format, prodFileChecks, scriptsMissingTz, versionAtLeast } from "../../scripts/doctor.ts";
import { finalRunsEnabled, readEnvFile, redact, SERVICE_TOKENS, upsertEnv } from "../../scripts/setup-prod.ts";

describe("setup:prod helpers", () => {
  it("never shows secret values in a printed command", () => {
    const line = redact(["wrangler", "pipelines", "sinks", "create", "s", "--catalog-token", "s3cr3t-token-value"], ["s3cr3t-token-value"]);
    expect(line).toBe("wrangler pipelines sinks create s --catalog-token <redacted>");
  });

  it("writes env files with mode 600 and replaces keys in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-env-"));
    const path = join(dir, "secrets.env");
    writeFileSync(path, "# comment\nA=1\nB=2\n");
    upsertEnv(path, { B: "3", C: "4" });
    expect(readEnvFile(path)).toEqual({ A: "1", B: "3", C: "4" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("B=2");
  });

  it("enables runs only after a passing bootstrap and honours --runs-enabled false", () => {
    expect(finalRunsEnabled(true, undefined)).toBe(true);
    expect(finalRunsEnabled(false, undefined)).toBe(false);
    expect(finalRunsEnabled(true, "false")).toBe(false);
    expect(finalRunsEnabled(false, "true")).toBe(false);
    expect(() => finalRunsEnabled(true, "no")).toThrow(/true or false/);
  });

  it("creates one service token per source, the runner and the doctor", () => {
    expect(Object.values(SERVICE_TOKENS).map((t) => t.role).sort()).toEqual(["operator", "runner", "source:ats", "source:hris", "source:talent"]);
  });
});

describe("doctor helpers", () => {
  it("compares versions", () => {
    expect(versionAtLeast("v25.9.0", "22.18.0")).toBe(true);
    expect(versionAtLeast("v22.17.9", "22.18.0")).toBe(false);
    expect(versionAtLeast("22.18.0", "22.18.0")).toBe(true);
  });

  it("flags npm scripts that run node, vitest or uv without TZ=UTC, and the repo's own scripts pass", () => {
    expect(scriptsMissingTz({ a: "vitest run", b: "TZ=UTC vitest run", c: "tsc -p tsconfig.node.json", d: "wrangler types" })).toEqual(["a", "c"]);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(scriptsMissingTz(pkg.scripts)).toEqual([]);
  });

  it("prints the fix only for checks that did not pass", () => {
    expect(format({ name: "x", status: "PASS", fix: "do y" })).toBe("PASS     x");
    expect(format({ name: "x", status: "MISSING", detail: "d", fix: "do y" })).toBe("MISSING  x: d\n         fix: do y");
  });

  it("reports secret names, never values, and loose file modes", () => {
    const root = mkdtempSync(join(tmpdir(), "pl-doc-"));
    const prod = join(root, ".prod");
    mkdirSync(prod);
    writeFileSync(join(prod, "config.env"), "PL_GCP_PROJECT=p\n", { mode: 0o644 });
    writeFileSync(join(prod, "secrets.env"), "PL_CF_SETUP_TOKEN=very-secret-value\n", { mode: 0o600 });
    const lines = prodFileChecks(root).map(format).join("\n");
    expect(lines).toContain("WARN     .prod/config.env mode");
    expect(lines).toContain("PL_R2_SINK_TOKEN");
    expect(lines).not.toContain("very-secret-value");
  });
});
