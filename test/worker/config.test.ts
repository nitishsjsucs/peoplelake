import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/worker/config.ts";

const ROLE_MAP = JSON.stringify({ emails: { "a@b.co": ["viewer"] }, service_tokens: { "runner.access": "runner" } });

const local = (): Record<string, unknown> => ({
  ENVIRONMENT: "local",
  AUTH_MODE: "dev",
  LAKE_MODE: "local",
  RUNNER_DISPATCH: "poll",
  RUNS_ENABLED: "true",
  ACCESS_TEAM_DOMAIN: "https://peoplelake-dev.local",
  ACCESS_AUD: "peoplelake-dev",
  ACCESS_ROLE_MAP: ROLE_MAP,
  EVAL_FAULTS_ENABLED: "true",
  DEV_ACCESS_JWKS: '{"keys":[]}',
});

const production = (): Record<string, unknown> => ({
  ENVIRONMENT: "production",
  AUTH_MODE: "access",
  LAKE_MODE: "basin",
  RUNNER_DISPATCH: "cloudrun",
  RUNS_ENABLED: "true",
  ACCESS_TEAM_DOMAIN: "https://peoplelake.cloudflareaccess.com",
  ACCESS_AUD: "0123abcd",
  ACCESS_ROLE_MAP: ROLE_MAP,
  EVAL_FAULTS_ENABLED: "false",
  GCP_PROJECT: "peoplelake-123",
  GCP_DISPATCHER_KEY: "{}",
  R2_CATALOG_TOKEN: "token",
  BASIN_CATALOG_URI: "https://catalog.example/iceberg",
  BASIN_CATALOG_PREFIX: "abc_peoplelake-lake",
});

const fails = (env: Record<string, unknown>, host: string | null, pattern: RegExp) =>
  expect(() => parseConfig(env, host)).toThrow(pattern);

describe("parseConfig fail-closed rules", () => {
  it("accepts the local configuration on 127.0.0.1 and localhost", () => {
    expect(parseConfig(local(), "127.0.0.1").devRoutes).toBe(true);
    expect(parseConfig(local(), "localhost").environment).toBe("local");
  });

  it("accepts a complete production configuration without dev routes", () => {
    const cfg = parseConfig(production(), "peoplelake.example.workers.dev");
    expect(cfg.devRoutes).toBe(false);
    expect(cfg.gcp).toEqual({ project: "peoplelake-123", region: "us-central1", job: "peoplelake-runner" });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("refuses a local configuration served on another host", () => {
    fails(local(), "peoplelake-local.example.workers.dev", /serves only 127.0.0.1/);
  });

  it("refuses dev auth without dev keys", () => {
    fails({ ...local(), DEV_ACCESS_JWKS: "" }, "127.0.0.1", /DEV_ACCESS_JWKS/);
  });

  it.each([
    ["AUTH_MODE", "dev", /AUTH_MODE=access/],
    ["LAKE_MODE", "local", /LAKE_MODE=basin/],
    ["RUNNER_DISPATCH", "poll", /RUNNER_DISPATCH=cloudrun/],
    ["EVAL_FAULTS_ENABLED", "true", /EVAL_FAULTS_ENABLED=false/],
    ["ACCESS_TEAM_DOMAIN", "https://peoplelake-dev.local", /cloudflareaccess\.com/],
    ["ACCESS_TEAM_DOMAIN", "http://peoplelake.cloudflareaccess.com", /cloudflareaccess\.com/],
  ])("production refuses %s=%s", (name, value, pattern) => {
    fails({ ...production(), [name]: value }, null, pattern);
  });

  it.each(["GCP_DISPATCHER_KEY", "R2_CATALOG_TOKEN", "BASIN_CATALOG_URI", "BASIN_CATALOG_PREFIX"])(
    "RUNS_ENABLED=true in production requires %s",
    (name) => {
      fails({ ...production(), [name]: "" }, null, new RegExp(`requires ${name}`));
      expect(parseConfig({ ...production(), [name]: "", RUNS_ENABLED: "false" }, null).runsEnabled).toBe(false);
    },
  );

  it("allows ACCESS_AUD=pending only while runs are disabled (fail-closed first deploy)", () => {
    fails({ ...production(), ACCESS_AUD: "pending" }, null, /pending/);
    expect(parseConfig({ ...production(), ACCESS_AUD: "pending", RUNS_ENABLED: "false" }, null).access.aud).toBe("pending");
  });

  it("refuses unrendered placeholders, bad role maps, unknown modes and bad numbers", () => {
    fails({ ...production(), ACCESS_AUD: "__PL_ACCESS_AUD__" }, null, /placeholder/);
    fails({ ...local(), ACCESS_ROLE_MAP: '{"emails":{}}' }, "127.0.0.1", /role map/);
    fails({ ...local(), ACCESS_ROLE_MAP: "not json" }, "127.0.0.1", /role map/);
    fails({ ...local(), ENVIRONMENT: "staging" }, "127.0.0.1", /ENVIRONMENT must be one of/);
    fails({ ...local(), JOB_LEASE_SECONDS: "-5" }, "127.0.0.1", /non-negative integer/);
    fails({ ...local(), JOB_MAX_ATTEMPTS: "0" }, "127.0.0.1", /at least 1/);
    expect(() => parseConfig({ ...local(), RUNS_ENABLED: "yes" }, "127.0.0.1")).toThrow(ConfigError);
  });

  it("turns every request into 500 config when the host is not local", async () => {
    const res = await SELF.fetch("http://peoplelake-local.example.workers.dev/v1/health");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "config" });
  });
});
