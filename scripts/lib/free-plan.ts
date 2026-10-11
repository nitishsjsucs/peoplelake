// Workers Free plan rules for a wrangler config (SPEC 29, 15.7): what predeploy-check, the doctor and the
// budget script refuse, and the budget inputs read from the production configuration.
import { MAX_BATCH_EVENTS } from "../../src/shared/contracts.ts";
import {
  AI_DAILY_NEURON_CAP,
  AI_DEPRECATED_MODELS,
  AI_MAX_TOKENS,
  AI_PAID_BILLING_MODELS,
  type BudgetInputs,
  CRON_EXPRESSION,
  GUARD_BOUNDS,
  PRODUCTION_GUARDS,
} from "../../src/shared/free-budget.ts";
import { parseJsonc } from "../render-wrangler.ts";

interface QueueConsumer {
  queue: string;
  max_retries?: number;
  max_batch_size?: number;
}

interface EnvConfig {
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
  durable_objects?: { bindings?: { name: string; class_name: string }[] };
  r2_buckets?: { binding: string; bucket_name: string }[];
  queues?: { producers?: { binding: string; queue: string }[]; consumers?: QueueConsumer[] };
  pipelines?: unknown;
  limits?: unknown;
}

export interface WranglerConfig extends EnvConfig {
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  env?: { production?: EnvConfig };
}

/** Production sources post every 10 s (SPEC 29.4.2); the Python delivery uses the same value. */
export const PROD_SOURCE_TICK_SECONDS = 10;
/** Production secrets of the Worker (SPEC 29.6): the dispatcher key only. */
export const PRODUCTION_SECRETS = ["GCP_DISPATCHER_KEY"] as const;

/** Every reason a config would need Workers Paid or pass a Free plan budget. Empty when it is fine. */
export function freePlanConfigProblems(configText: string): string[] {
  const config = parseJsonc<WranglerConfig>(configText, "wrangler config");
  const prod = config.env?.production;
  const problems: string[] = [];
  const envs: [string, EnvConfig | undefined][] = [
    ["top level", config],
    ["production", prod],
  ];
  for (const [name, env] of envs) {
    if (!env) continue;
    if (env.pipelines !== undefined) problems.push(`${name}: a pipelines binding needs Workers Paid (Basin Pipelines)`);
    if (env.limits !== undefined) problems.push(`${name}: limits (cpu_ms) is a Workers Paid setting`);
    const crons = env.triggers?.crons ?? config.triggers?.crons ?? [];
    if (crons.length !== 1 || crons[0] !== CRON_EXPRESSION) {
      problems.push(`${name}: exactly one cron, ${CRON_EXPRESSION}, is allowed (found ${JSON.stringify(crons)})`);
    }
    const sqlite = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
    for (const b of env.durable_objects?.bindings ?? []) {
      if (!sqlite.has(b.class_name)) problems.push(`${name}: Durable Object ${b.class_name} must be a SQLite class (the only backend on Free)`);
    }
  }
  for (const m of config.migrations ?? []) {
    if ((m.new_classes ?? []).length > 0) problems.push(`migration ${m.tag}: key-value Durable Object classes need Workers Paid`);
  }
  if (prod) {
    const vars = prod.vars ?? {};
    const model = vars["AI_MODEL"] ?? "";
    if ((AI_PAID_BILLING_MODELS as readonly string[]).includes(model)) problems.push(`production AI_MODEL ${model} needs a paid billing method`);
    if ((AI_DEPRECATED_MODELS as readonly string[]).includes(model)) problems.push(`production AI_MODEL ${model} is deprecated`);
    const expected: Record<string, string> = {
      ...Object.fromEntries(Object.entries(PRODUCTION_GUARDS).map(([k, v]) => [k, String(v)])),
      AI_MAX_TOKENS: String(AI_MAX_TOKENS),
      AI_DAILY_NEURON_CAP: String(AI_DAILY_NEURON_CAP),
    };
    for (const [k, v] of Object.entries(expected)) {
      if (vars[k] !== v) problems.push(`production ${k} must be ${v} (is ${vars[k] ?? "unset"})`);
    }
    // Values the peak-day estimates assume (more rolls, retries or attempts multiply Queue operations and
    // Workflow steps): the same bounds parseConfig enforces in production.
    const b = GUARD_BOUNDS;
    const n = (k: string, fallback: number) => (/^\d+$/.test(vars[k] ?? "") ? Number(vars[k]) : fallback);
    if (n("LANDING_ROLL_SECONDS", 60) < b.landingRollSecondsAtLeast) problems.push(`production LANDING_ROLL_SECONDS must be at least ${b.landingRollSecondsAtLeast}`);
    if (n("JOB_MAX_ATTEMPTS", 3) > b.jobMaxAttemptsAtMost) problems.push(`production JOB_MAX_ATTEMPTS must be at most ${b.jobMaxAttemptsAtMost}`);
    if (n("RUN_TIMEOUT_MINUTES", 10) > b.runTimeoutMinutesAtMost) problems.push(`production RUN_TIMEOUT_MINUTES must be at most ${b.runTimeoutMinutesAtMost}`);
    for (const c of prod.queues?.consumers ?? []) {
      if ((c.max_retries ?? 3) > b.queueMaxRetriesAtMost) problems.push(`production queue consumer ${c.queue}: max_retries must be at most ${b.queueMaxRetriesAtMost}`);
      if (c.max_batch_size !== undefined && c.max_batch_size > 10) problems.push(`production queue consumer ${c.queue}: max_batch_size must be at most 10`);
    }
    if (!(prod.r2_buckets ?? []).some((b) => b.binding === "LAKE_BUCKET" && b.bucket_name === "peoplelake-lake")) {
      problems.push("production must bind LAKE_BUCKET to peoplelake-lake (the landing)");
    }
    if (!(prod.queues?.producers ?? []).some((p) => p.binding === "LAKE_EVENTS")) problems.push("production must bind the LAKE_EVENTS producer");
    if (!(prod.durable_objects?.bindings ?? []).some((b) => b.name === "LANDING_ROLLER")) problems.push("production must bind LANDING_ROLLER");
  }
  return problems;
}

/** Budget inputs from the production configuration and the repo's constants. */
export function budgetInputsFromConfig(configText: string, opts: { humanSeats?: number } = {}): BudgetInputs {
  const config = parseJsonc<WranglerConfig>(configText, "wrangler config");
  const prod = config.env?.production ?? {};
  const vars = prod.vars ?? {};
  const num = (name: string, fallback: number) => (vars[name] !== undefined && /^\d+$/.test(vars[name] ?? "") ? Number(vars[name]) : fallback);
  const consumer = (prod.queues?.consumers ?? config.queues?.consumers ?? []).find((c) => c.queue === "peoplelake-lake-events");
  return {
    maxBatchEvents: MAX_BATCH_EVENTS,
    deliveryEvents: 100_000,
    deliveryMinutes: 60,
    sourceTickSeconds: PROD_SOURCE_TICK_SECONDS,
    sources: 3,
    landingRollSeconds: num("LANDING_ROLL_SECONDS", 60),
    queueMaxRetries: consumer?.max_retries ?? 3,
    cronExpressions: prod.triggers?.crons ?? config.triggers?.crons ?? [],
    runMinIntervalSeconds: num("RUN_MIN_INTERVAL_SECONDS", 0),
    autoRunsMaxPerDay: num("AUTO_RUNS_MAX_PER_DAY", 100_000),
    aiDailyNeuronCap: num("AI_DAILY_NEURON_CAP", AI_DAILY_NEURON_CAP),
    bqMonthlyBytesCap: num("BQ_MONTHLY_BYTES_CAP", PRODUCTION_GUARDS.BQ_MONTHLY_BYTES_CAP),
    envVars: Object.keys(vars).length + PRODUCTION_SECRETS.length,
    humanSeats: opts.humanSeats ?? 2,
    serviceTokens: 5,
    drillScenarios: 6,
    drillChunks: 10,
  };
}

/** `PL_PERSONA_EMAILS=a@x.com:viewer,b@x.com:viewer|operator` -> {email: roles}. Throws on a bad entry. */
export function parsePersonaEmails(text: string): Record<string, ("viewer" | "operator")[]> {
  const out: Record<string, ("viewer" | "operator")[]> = {};
  for (const entry of text.split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.lastIndexOf(":");
    const email = (i > 0 ? entry.slice(0, i) : entry).trim().toLowerCase();
    const roles = (i > 0 ? entry.slice(i + 1) : "viewer").split("|").map((r) => r.trim());
    if (!/^[^\s@,:]+@[^\s@,:]+\.[a-z]{2,}$/i.test(email)) throw new Error(`PL_PERSONA_EMAILS: not an email address: ${email}`);
    for (const r of roles) if (r !== "viewer" && r !== "operator") throw new Error(`PL_PERSONA_EMAILS: unknown role ${r} for ${email}`);
    out[email] = roles as ("viewer" | "operator")[];
  }
  return out;
}
