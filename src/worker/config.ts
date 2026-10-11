// parseConfig(env, requestHost): every rule fails closed (SPEC 7.2). A config error turns every request
// into 500 {"error":"config"} and makes scheduled handlers do nothing.
import { z } from "zod";
import { AI_DAILY_NEURON_CAP, AI_DAILY_NEURON_CAP_AT_MOST, AI_MAX_TOKENS, GUARD_BOUNDS, PRODUCTION_GUARDS } from "../shared/free-budget.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** The Cloud Run runner (`runner run --until-idle 15` in the Dockerfile and bootstrap) polls every 2 s
 * while idle and exits after 15 idle seconds. A runner seen within RUNNER_SEEN_WINDOW_SECONDS must still
 * be polling, so production keeps the window below the idle exit minus one poll (test/node checks the
 * runner's own values against these). */
export const RUNNER_IDLE_EXIT_SECONDS = 15;
export const RUNNER_POLL_SECONDS = 2;
export const RUNNER_SEEN_WINDOW_SECONDS_AT_MOST = 10;

export const ROLES = ["viewer", "operator", "runner", "source:hris", "source:ats", "source:talent"] as const;
export type Role = (typeof ROLES)[number];

const RoleMapSchema = z
  .object({
    emails: z.record(z.string().min(3), z.array(z.enum(["viewer", "operator"])).min(1)),
    // One role per machine identity; `operator` is the doctor's token for the /api/ops/* checks.
    service_tokens: z.record(z.string().min(1), z.enum(["runner", "source:hris", "source:ats", "source:talent", "operator"])),
  })
  .strict();
export type RoleMap = z.infer<typeof RoleMapSchema>;

/** zod builds the role map parser on first use; parseConfig runs on every request, so the Worker entry
 * builds it at isolate startup (with the ingest prewarm) instead of in the first request's 10 ms. */
export function prewarmConfig(): void {
  RoleMapSchema.parse({ emails: { "prewarm@peoplelake.local": ["viewer"] }, service_tokens: { "prewarm.access": "runner" } });
}

export interface AppConfig {
  readonly environment: "local" | "production";
  readonly authMode: "dev" | "access";
  readonly lakeMode: "local" | "basin";
  readonly runnerDispatch: "poll" | "cloudrun";
  readonly runsEnabled: boolean;
  readonly access: { readonly teamDomain: string; readonly aud: string; readonly roleMap: RoleMap };
  readonly devAccessJwks: string | null;
  readonly jobs: {
    readonly leaseSeconds: number;
    readonly claimTimeoutSeconds: number;
    readonly maxAttempts: number;
    readonly runTimeoutMinutes: number;
  };
  readonly landing: { readonly rollSeconds: number; readonly rollMaxBytes: number; readonly maxBufferBytes: number };
  readonly heartbeatMinutes: number;
  /** Free plan guards on automatic runs and the monthly BigQuery guard (SPEC 29.4.3). */
  readonly guards: {
    readonly runMinIntervalSeconds: number;
    readonly failureBackoffBaseMinutes: number;
    readonly failureBackoffMaxMinutes: number;
    readonly autoRunsMaxPerDay: number;
    readonly bqMonthlyBytesCap: number;
  };
  readonly runnerSeenWindowSeconds: number;
  readonly evalFaultsEnabled: boolean;
  readonly devRoutes: boolean;
  readonly ai: {
    readonly provider: "stub" | "openai-compatible" | "workers-ai";
    readonly model: string | null;
    readonly gatewayId: string | null;
    readonly llmBaseUrl: string | null;
    /** Workers AI only: max_tokens on every call and this repo's neuron cap per UTC day (SPEC 29.4.5). */
    readonly maxTokens: number;
    readonly dailyNeuronCap: number;
  };
  readonly gcp: { readonly project: string; readonly region: string; readonly job: string } | null;
}

/** The string variables and secrets parseConfig reads (a structural subset of the generated Env). */
export type ConfigEnv = Partial<Record<string, unknown>>;

const ACCESS_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function str(env: ConfigEnv, name: string, fallback?: string): string {
  const value = env[name];
  if (typeof value === "string") {
    if (value.includes("__PL_")) throw new ConfigError(`${name} still holds a placeholder`);
    return value;
  }
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${name} is not set`);
}

function oneOf<T extends string>(env: ConfigEnv, name: string, allowed: readonly T[], fallback?: T): T {
  const value = str(env, name, fallback);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function bool(env: ConfigEnv, name: string, fallback: "true" | "false"): boolean {
  return oneOf(env, name, ["true", "false"] as const, fallback) === "true";
}

function int(env: ConfigEnv, name: string, fallback: number, min = 0): number {
  const raw = str(env, name, String(fallback));
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min) throw new ConfigError(`${name} must be at least ${min}`);
  return n;
}

function secret(env: ConfigEnv, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseConfig(env: ConfigEnv, requestHost: string | null): AppConfig {
  const environment = oneOf(env, "ENVIRONMENT", ["local", "production"] as const);
  const authMode = oneOf(env, "AUTH_MODE", ["dev", "access"] as const);
  const lakeMode = oneOf(env, "LAKE_MODE", ["local", "basin"] as const);
  const runnerDispatch = oneOf(env, "RUNNER_DISPATCH", ["poll", "cloudrun"] as const);
  const runsEnabled = bool(env, "RUNS_ENABLED", "false");
  const evalFaultsEnabled = bool(env, "EVAL_FAULTS_ENABLED", "false");
  const teamDomain = str(env, "ACCESS_TEAM_DOMAIN");
  const aud = str(env, "ACCESS_AUD");

  let roleMap: RoleMap;
  try {
    roleMap = RoleMapSchema.parse(JSON.parse(str(env, "ACCESS_ROLE_MAP")));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("ACCESS_ROLE_MAP is not a valid role map");
  }

  const provider = oneOf(env, "AI_PROVIDER", ["stub", "openai-compatible", "workers-ai"] as const, "stub");
  const devAccessJwks = secret(env, "DEV_ACCESS_JWKS");

  if (environment === "production") {
    if (authMode !== "access") throw new ConfigError("production requires AUTH_MODE=access");
    if (lakeMode !== "basin") throw new ConfigError("production requires LAKE_MODE=basin");
    if (runnerDispatch !== "cloudrun") throw new ConfigError("production requires RUNNER_DISPATCH=cloudrun");
    if (evalFaultsEnabled) throw new ConfigError("production requires EVAL_FAULTS_ENABLED=false");
    if (!ACCESS_DOMAIN.test(teamDomain)) {
      throw new ConfigError("ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com in production");
    }
    if (aud === "pending" && runsEnabled) throw new ConfigError("ACCESS_AUD=pending is allowed only with RUNS_ENABLED=false");
    // The Worker holds no catalog token: the runner commits to Basin Catalog (SPEC 29.6).
    if (runsEnabled && secret(env, "GCP_DISPATCHER_KEY") === null) {
      throw new ConfigError("RUNS_ENABLED=true requires GCP_DISPATCHER_KEY");
    }
  } else {
    if (requestHost !== null && !LOCAL_HOSTS.has(requestHost)) {
      throw new ConfigError("ENVIRONMENT=local serves only 127.0.0.1 and localhost");
    }
    if (authMode === "dev" && devAccessJwks === null) {
      throw new ConfigError("AUTH_MODE=dev requires DEV_ACCESS_JWKS (run `peoplelake auth dev-keys`)");
    }
  }

  // Unset guard values default to the Free plan values in production and to wide values locally.
  const prod = environment === "production";
  const P = PRODUCTION_GUARDS;
  const heartbeatMinutes = int(env, "HEARTBEAT_MINUTES", P.HEARTBEAT_MINUTES);
  const guards = {
    runMinIntervalSeconds: int(env, "RUN_MIN_INTERVAL_SECONDS", prod ? P.RUN_MIN_INTERVAL_SECONDS : 0),
    failureBackoffBaseMinutes: int(env, "FAILURE_BACKOFF_BASE_MINUTES", prod ? P.FAILURE_BACKOFF_BASE_MINUTES : 0),
    failureBackoffMaxMinutes: int(env, "FAILURE_BACKOFF_MAX_MINUTES", P.FAILURE_BACKOFF_MAX_MINUTES),
    autoRunsMaxPerDay: int(env, "AUTO_RUNS_MAX_PER_DAY", prod ? P.AUTO_RUNS_MAX_PER_DAY : 100_000, 1),
    bqMonthlyBytesCap: int(env, "BQ_MONTHLY_BYTES_CAP", P.BQ_MONTHLY_BYTES_CAP, 1),
  };
  const aiMaxTokens = int(env, "AI_MAX_TOKENS", AI_MAX_TOKENS, 1);
  const aiDailyNeuronCap = int(env, "AI_DAILY_NEURON_CAP", AI_DAILY_NEURON_CAP, 1);
  const runnerSeenWindowSeconds = int(env, "RUNNER_SEEN_WINDOW_SECONDS", RUNNER_SEEN_WINDOW_SECONDS_AT_MOST);
  if (guards.failureBackoffMaxMinutes < guards.failureBackoffBaseMinutes) {
    throw new ConfigError("FAILURE_BACKOFF_MAX_MINUTES must be at least FAILURE_BACKOFF_BASE_MINUTES");
  }
  if (prod) {
    // Values outside the Workers Free plan budget (src/shared/free-budget.ts) never reach production.
    const b = GUARD_BOUNDS;
    if (guards.runMinIntervalSeconds < b.runMinIntervalSecondsAtLeast) {
      throw new ConfigError(`production requires RUN_MIN_INTERVAL_SECONDS >= ${b.runMinIntervalSecondsAtLeast}`);
    }
    if (guards.failureBackoffBaseMinutes < b.failureBackoffBaseMinutesAtLeast) {
      throw new ConfigError(`production requires FAILURE_BACKOFF_BASE_MINUTES >= ${b.failureBackoffBaseMinutesAtLeast}`);
    }
    if (guards.autoRunsMaxPerDay > b.autoRunsMaxPerDayAtMost) {
      throw new ConfigError(`production requires AUTO_RUNS_MAX_PER_DAY <= ${b.autoRunsMaxPerDayAtMost}`);
    }
    if (guards.bqMonthlyBytesCap > b.bqMonthlyBytesCapAtMost) {
      throw new ConfigError(`production requires BQ_MONTHLY_BYTES_CAP <= ${b.bqMonthlyBytesCapAtMost}`);
    }
    if (heartbeatMinutes > b.heartbeatMinutesAtMost) throw new ConfigError("production requires HEARTBEAT_MINUTES=0 (heartbeat off)");
    const landingRoll = int(env, "LANDING_ROLL_SECONDS", 60, 1);
    if (landingRoll < b.landingRollSecondsAtLeast) throw new ConfigError(`production requires LANDING_ROLL_SECONDS >= ${b.landingRollSecondsAtLeast}`);
    if (int(env, "JOB_MAX_ATTEMPTS", 3, 1) > b.jobMaxAttemptsAtMost) throw new ConfigError(`production requires JOB_MAX_ATTEMPTS <= ${b.jobMaxAttemptsAtMost}`);
    if (int(env, "RUN_TIMEOUT_MINUTES", 10, 1) > b.runTimeoutMinutesAtMost) throw new ConfigError(`production requires RUN_TIMEOUT_MINUTES <= ${b.runTimeoutMinutesAtMost}`);
    if (runnerSeenWindowSeconds > RUNNER_SEEN_WINDOW_SECONDS_AT_MOST) {
      throw new ConfigError(
        `production requires RUNNER_SEEN_WINDOW_SECONDS <= ${RUNNER_SEEN_WINDOW_SECONDS_AT_MOST} (the runner exits after ${RUNNER_IDLE_EXIT_SECONDS} idle seconds)`,
      );
    }
    if (aiMaxTokens > AI_MAX_TOKENS) throw new ConfigError(`production requires AI_MAX_TOKENS <= ${AI_MAX_TOKENS}`);
    if (aiDailyNeuronCap > AI_DAILY_NEURON_CAP_AT_MOST) {
      throw new ConfigError(`production requires AI_DAILY_NEURON_CAP <= ${AI_DAILY_NEURON_CAP_AT_MOST}`);
    }
  }
  const gcpProject = secret(env, "GCP_PROJECT");
  const rollMaxBytes = int(env, "LANDING_ROLL_MAX_BYTES", 8 * 1024 * 1024, 1024);
  const maxBufferBytes = int(env, "LANDING_MAX_BUFFER_BYTES", 64 * 1024 * 1024, 1024);
  if (maxBufferBytes < rollMaxBytes) throw new ConfigError("LANDING_MAX_BUFFER_BYTES must be at least LANDING_ROLL_MAX_BYTES");
  return Object.freeze({
    environment,
    authMode,
    lakeMode,
    runnerDispatch,
    runsEnabled,
    access: { teamDomain, aud, roleMap },
    devAccessJwks,
    jobs: {
      leaseSeconds: int(env, "JOB_LEASE_SECONDS", 60, 1),
      claimTimeoutSeconds: int(env, "JOB_CLAIM_TIMEOUT_SECONDS", 30, 1),
      maxAttempts: int(env, "JOB_MAX_ATTEMPTS", 3, 1),
      runTimeoutMinutes: int(env, "RUN_TIMEOUT_MINUTES", 10, 1),
    },
    landing: { rollSeconds: int(env, "LANDING_ROLL_SECONDS", 60, 1), rollMaxBytes, maxBufferBytes },
    heartbeatMinutes,
    guards,
    runnerSeenWindowSeconds,
    evalFaultsEnabled,
    devRoutes: environment === "local",
    ai: {
      provider,
      model: secret(env, "AI_MODEL"),
      gatewayId: secret(env, "AI_GATEWAY_ID"),
      llmBaseUrl: secret(env, "LLM_BASE_URL"),
      maxTokens: aiMaxTokens,
      dailyNeuronCap: aiDailyNeuronCap,
    },
    gcp: gcpProject
      ? { project: gcpProject, region: str(env, "GCP_REGION", "us-central1"), job: str(env, "CLOUD_RUN_JOB", "peoplelake-runner") }
      : null,
  } satisfies AppConfig);
}
