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

  it("lets a service token hold the operator role (the doctor's identity) but nothing else unknown", () => {
    const map = JSON.stringify({ emails: {}, service_tokens: { "doctor.access": "operator" } });
    expect(parseConfig({ ...local(), ACCESS_ROLE_MAP: map }, "127.0.0.1").access.roleMap.service_tokens["doctor.access"]).toBe("operator");
    const bad = JSON.stringify({ emails: {}, service_tokens: { "x.access": "admin" } });
    fails({ ...local(), ACCESS_ROLE_MAP: bad }, "127.0.0.1", /role map/);
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

  it("RUNS_ENABLED=true in production requires GCP_DISPATCHER_KEY and no catalog token or URI (the runner commits)", () => {
    fails({ ...production(), GCP_DISPATCHER_KEY: "" }, null, /requires GCP_DISPATCHER_KEY/);
    expect(parseConfig({ ...production(), GCP_DISPATCHER_KEY: "", RUNS_ENABLED: "false" }, null).runsEnabled).toBe(false);
    expect(parseConfig(production(), null).runsEnabled).toBe(true);
  });

  it("reads the landing settings with Free plan defaults and refuses a buffer smaller than a roll", () => {
    expect(parseConfig(local(), "127.0.0.1").landing).toEqual({ rollSeconds: 60, rollMaxBytes: 8388608, maxBufferBytes: 67108864 });
    fails({ ...local(), LANDING_ROLL_MAX_BYTES: "4096", LANDING_MAX_BUFFER_BYTES: "2048" }, "127.0.0.1", /LANDING_MAX_BUFFER_BYTES/);
    fails({ ...local(), LANDING_ROLL_SECONDS: "0" }, "127.0.0.1", /at least 1/);
  });

  it("defaults production to the Free plan guards and refuses values outside their bounds", () => {
    expect(parseConfig(production(), null).guards).toEqual({
      runMinIntervalSeconds: 240,
      failureBackoffBaseMinutes: 5,
      failureBackoffMaxMinutes: 360,
      autoRunsMaxPerDay: 30,
      bqMonthlyBytesCap: 275_000_000_000,
    });
    expect(parseConfig(production(), null).heartbeatMinutes).toBe(0);
    fails({ ...production(), RUN_MIN_INTERVAL_SECONDS: "60" }, null, /RUN_MIN_INTERVAL_SECONDS >= 240/);
    fails({ ...production(), FAILURE_BACKOFF_BASE_MINUTES: "1" }, null, /FAILURE_BACKOFF_BASE_MINUTES >= 5/);
    fails({ ...production(), AUTO_RUNS_MAX_PER_DAY: "31" }, null, /AUTO_RUNS_MAX_PER_DAY <= 30/);
    fails({ ...production(), BQ_MONTHLY_BYTES_CAP: "300000000000" }, null, /BQ_MONTHLY_BYTES_CAP <= 275000000000/);
    fails({ ...production(), HEARTBEAT_MINUTES: "360" }, null, /HEARTBEAT_MINUTES=0/);
    fails({ ...local(), FAILURE_BACKOFF_BASE_MINUTES: "10", FAILURE_BACKOFF_MAX_MINUTES: "5" }, "127.0.0.1", /FAILURE_BACKOFF_MAX_MINUTES/);
    expect(parseConfig(local(), "127.0.0.1").guards.runMinIntervalSeconds).toBe(0);
  });

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
