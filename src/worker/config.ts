// parseConfig(env, requestHost): every rule fails closed (SPEC 7.2). A config error turns every request
// into 500 {"error":"config"} and makes scheduled handlers do nothing.
import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const ROLES = ["viewer", "operator", "runner", "source:hris", "source:ats", "source:talent"] as const;
export type Role = (typeof ROLES)[number];

const RoleMapSchema = z
  .object({
    emails: z.record(z.string().min(3), z.array(z.enum(["viewer", "operator"])).min(1)),
    service_tokens: z.record(z.string().min(1), z.enum(["runner", "source:hris", "source:ats", "source:talent"])),
  })
  .strict();
export type RoleMap = z.infer<typeof RoleMapSchema>;

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
  readonly sink: { readonly rollSeconds: number; readonly maxRecords: number };
  readonly heartbeatMinutes: number;
  readonly runnerSeenWindowSeconds: number;
  readonly evalFaultsEnabled: boolean;
  readonly devRoutes: boolean;
  readonly ai: {
    readonly provider: "stub" | "openai-compatible" | "workers-ai";
    readonly model: string | null;
    readonly gatewayId: string | null;
    readonly llmBaseUrl: string | null;
  };
  readonly gcp: { readonly project: string; readonly region: string; readonly job: string } | null;
  readonly basin: { readonly catalogUri: string; readonly catalogPrefix: string } | null;
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
    if (runsEnabled) {
      for (const name of ["GCP_DISPATCHER_KEY", "R2_CATALOG_TOKEN", "BASIN_CATALOG_URI", "BASIN_CATALOG_PREFIX"]) {
        if (secret(env, name) === null) throw new ConfigError(`RUNS_ENABLED=true requires ${name}`);
      }
    }
  } else {
    if (requestHost !== null && !LOCAL_HOSTS.has(requestHost)) {
      throw new ConfigError("ENVIRONMENT=local serves only 127.0.0.1 and localhost");
    }
    if (authMode === "dev" && devAccessJwks === null) {
      throw new ConfigError("AUTH_MODE=dev requires DEV_ACCESS_JWKS (run `peoplelake auth dev-keys`)");
    }
  }

  const gcpProject = secret(env, "GCP_PROJECT");
  const catalogUri = secret(env, "BASIN_CATALOG_URI");
  const catalogPrefix = secret(env, "BASIN_CATALOG_PREFIX");
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
    sink: { rollSeconds: int(env, "SINK_ROLL_SECONDS", 60, 1), maxRecords: int(env, "LOCAL_SINK_MAX_RECORDS", 50000, 1) },
    heartbeatMinutes: int(env, "HEARTBEAT_MINUTES", 0),
    runnerSeenWindowSeconds: int(env, "RUNNER_SEEN_WINDOW_SECONDS", 60),
    evalFaultsEnabled,
    devRoutes: environment === "local",
    ai: {
      provider,
      model: secret(env, "AI_MODEL"),
      gatewayId: secret(env, "AI_GATEWAY_ID"),
      llmBaseUrl: secret(env, "LLM_BASE_URL"),
    },
    gcp: gcpProject
      ? { project: gcpProject, region: str(env, "GCP_REGION", "us-central1"), job: str(env, "CLOUD_RUN_JOB", "peoplelake-runner") }
      : null,
    basin: catalogUri && catalogPrefix ? { catalogUri, catalogPrefix } : null,
  } satisfies AppConfig);
}
