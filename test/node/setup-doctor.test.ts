import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { format, freePlanChecks, opsBudgetChecks, prodFileChecks, scriptsMissingTz, versionAtLeast } from "../../scripts/doctor.ts";
import { parsePersonaEmails } from "../../scripts/lib/free-plan.ts";
import { buildRoleMap, type Exec, finalRunsEnabled, readEnvFile, redact, SERVICE_TOKENS, Setup, upsertEnv } from "../../scripts/setup-prod.ts";

describe("setup:prod helpers", () => {
  it("never shows secret values in a printed command", () => {
    const line = redact(["wrangler", "basin", "catalog", "snapshot-expiration", "enable", "b", "--token", "s3cr3t-token-value"], ["s3cr3t-token-value"]);
    expect(line).toBe("wrangler basin catalog snapshot-expiration enable b --token <redacted>");
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
    expect(lines).toContain("PL_R2_CATALOG_TOKEN");
    expect(lines).not.toContain("PL_R2_SINK_TOKEN");
    expect(lines).not.toContain("very-secret-value");
  });
});


describe("setup:prod on the Workers Free plan (SPEC 21.0)", () => {
  function dryRun(): string {
    const root = mkdtempSync(join(tmpdir(), "pl-setup-"));
    mkdirSync(join(root, ".prod"));
    writeFileSync(
      join(root, ".prod", "config.env"),
      [
        "PL_CF_ACCOUNT_ID=00000000000000000000000000000000",
        "PL_WORKERS_SUBDOMAIN=example",
        "PL_ACCESS_TEAM_DOMAIN=https://example.cloudflareaccess.com",
        "PL_OWNER_EMAIL=owner@example.com",
        "PL_PERSONA_EMAILS=owner+hr@example.com:viewer",
        "PL_GCP_PROJECT=example-project",
      ].join("\n"),
    );
    writeFileSync(join(root, ".prod", "secrets.env"), "PL_CF_SETUP_TOKEN=setup-token-value\nPL_R2_CATALOG_TOKEN=catalog-token-value\n");
    const exec: Exec = (argv) => {
      const cmd = argv.join(" ");
      if (cmd.endsWith("--version")) return { ok: true, stdout: cmd.includes("wrangler") ? "4.149.0" : "gcloud 587.0.0", stderr: "" };
      if (cmd.includes("billing projects describe")) return { ok: true, stdout: "True", stderr: "" };
      if (cmd.includes("whoami")) return { ok: true, stdout: "You are logged in", stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    };
    const http = async () => ({ ok: false, status: 404, json: { result: [] } });
    const setup = new Setup(root, true, { exec, http });
    return setup.all(undefined).then(() => setup.log.join("\n")) as unknown as string;
  }

  it("creates nothing that needs Workers Paid, names everything peoplelake and never prints a secret", async () => {
    const log = await dryRun();
    const commands = log.split("\n").filter((l) => /^\s+would (run|call):/.test(l));
    expect(commands.length).toBeGreaterThan(10);
    expect(commands.join("\n")).not.toMatch(/pipelines|notification|compaction/);
    expect(log).not.toContain("PL_R2_SINK_TOKEN");
    expect(log).toContain("lake init --target prod");
    expect(log).toContain("snapshot-expiration enable peoplelake-lake --token <redacted> --older-than-days 7 --retain-last 50");
    expect(log).not.toContain("catalog-token-value");
    expect(log).not.toContain("setup-token-value");
    for (const m of log.matchAll(/would run: npx wrangler (?:r2 bucket|queues) create (\S+)/g)) expect(m[1]).toMatch(/^peoplelake-/);
    for (const name of Object.keys(SERVICE_TOKENS)) expect(name).toMatch(/^peoplelake-/);
    expect(log).toMatch(/would call: POST .*\/access\/service_tokens \{"name":"peoplelake-source-hris"/);
    expect(log).toContain('"email":{"email":"owner+hr@example.com"}');
  });

  it("refuses to run while billing is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pl-setup-"));
    mkdirSync(join(root, ".prod"));
    writeFileSync(join(root, ".prod", "config.env"), "PL_GCP_PROJECT=example-project\n");
    writeFileSync(join(root, ".prod", "secrets.env"), "");
    const exec: Exec = (argv) => ({ ok: true, stdout: argv.join(" ").includes("billing") ? "False" : "", stderr: "" });
    const setup = new Setup(root, false, { exec, http: async () => ({ ok: false, status: 0, json: {} }) });
    await expect(setup.all("cloudflare")).rejects.toThrow(/preflight failed/);
    expect(setup.log.join("\n")).toContain("billing is not enabled on example-project");
  });

  it("maps the owner to viewer and operator, each persona to its roles and each token to one role", () => {
    expect(parsePersonaEmails("a+hr@x.com:viewer, b@x.com:viewer|operator")).toEqual({ "a+hr@x.com": ["viewer"], "b@x.com": ["viewer", "operator"] });
    expect(() => parsePersonaEmails("a@x.com:admin")).toThrow(/unknown role/);
    expect(() => parsePersonaEmails("not-an-email:viewer")).toThrow(/not an email/);
    const map = buildRoleMap("Owner@X.com", "owner+hr@x.com:viewer", { "peoplelake-runner": "runner-id.access" });
    expect(map.emails).toEqual({ "owner@x.com": ["viewer", "operator"], "owner+hr@x.com": ["viewer"] });
    expect(map.service_tokens["runner-id.access"]).toBe("runner");
  });
});

describe("doctor on the Workers Free plan", () => {
  it("fails a config with a pipelines binding and passes the repo's own", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(freePlanChecks(wrangler).map((c) => c.status)).toEqual(["PASS", "PASS"]);
    const paid = wrangler.replace('"name": "peoplelake-local",', '"name": "peoplelake-local", "pipelines": [{ "binding": "RAW_STREAM", "stream": "x" }],');
    expect(freePlanChecks(paid)[0]).toMatchObject({ status: "FAIL" });
  });

  it("prints production's /api/ops/budget against the planning shares", () => {
    const checks = opsBudgetChecks({
      durable_objects: { rows_read_today: 12_000, rows_written_today: 25_000 },
      runs: { automatic_today: 4, automatic_max_per_day: 30, consecutive_failures: 2, failure_backoff_until: Date.parse("2026-10-12T00:10:00Z"), workflow_steps_today: 40 },
      workers_ai: { neurons_today: 34, cap: 1800 },
      bigquery: { bytes_billed: 3_000_000_000, cap_bytes: 275_000_000_000, month: "2026-10" },
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["Durable Object rows written today"]).toMatchObject({ status: "WARN", detail: "25,000 of 20,000 rows (20% of 100,000)" });
    expect(by["Durable Object rows read today"]?.status).toBe("PASS");
    expect(by["failure backoff"]).toMatchObject({ status: "WARN" });
    expect(by["BigQuery bytes billed this month (2026-10)"]?.status).toBe("PASS");
  });
});
