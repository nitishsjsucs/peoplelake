// npm run doctor [-- --local-only | --quick | --with-dispatch | --with-ai]
//
// Checks every prerequisite (SPEC 21.3 and 21.0) and prints PASS, FAIL, MISSING, UNKNOWN, WARN or INFO per
// check, with the exact command, console step or README production setup step for every non-pass, then a
// summary that groups everything not passing by its fix. Never prints secret values, only names.
//
// Read only. It works before anything is provisioned: the account comes from `wrangler whoami`, and each
// resource that is not there yet is reported MISSING with the step that creates it. Every command goes
// through an allowlist of read commands (whoami, auth token, list, get) and every Cloudflare API call is
// a GET, and the live Worker probes have no side effects (the AI and dispatch checks read configuration
// only). The exceptions are opt-in: `--with-dispatch` asks the deployed Worker to start one runner
// execution, `--with-ai` makes one live Workers AI call through the gateway. Settings come from `.prod/config.env`, `.prod/secrets.env` and `.prod/state.json`; PL_*
// environment variables override `.prod/config.env`.
//
// Workers Free plan: the config must need nothing from Workers Paid (no pipelines, no limits, one cron,
// SQLite Durable Objects), the budget estimates must stay within the planning shares, and production's
// GET /api/ops/budget is printed against them. After the Cloudflare checks it runs
// `peoplelake prod doctor-gcp` (unless --local-only or --quick) and merges its checks into the summary.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { budgetRows, CLOUDFLARE_PLANNING_SHARE, overBudget } from "../src/shared/free-budget.ts";
import { budgetInputsFromConfig, freePlanConfigProblems } from "./lib/free-plan.ts";
import type { ProdState } from "./lib/prod-state.ts";
import { accessCookieProblems, bucketListed, type Exec, queueInfoNames, GATEWAY, type Http, LAKE_BUCKET, QUEUES, readEnvFile, realExec, realHttp, REPORTS_BUCKET, SERVICE_TOKENS, WORKER } from "./setup-prod.ts";

export type Status = "PASS" | "FAIL" | "MISSING" | "UNKNOWN" | "WARN" | "INFO";
export interface Check {
  name: string;
  status: Status;
  detail?: string;
  fix?: string;
}

const API = "https://api.cloudflare.com/client/v4";

// README "Production setup", "Steps only a person can do": the numbers the fixes cite (a test reads README).
export const README_STEP = { onetimePin: 1, catalogToken: 2, setupToken: 3, billing: 4, quotaProject: 6, prodFiles: 7, setup: 8, goLive: 10 } as const;
const step = (n: number) => `README production setup step ${n}`;
export const SETUP_FIX = `npm run setup:prod (${step(README_STEP.setup)})`;
export const PROD_FILES_FIX = `${step(README_STEP.prodFiles)}: .prod/config.env and .prod/secrets.env`;

export function format(c: Check): string {
  let line = `${c.status.padEnd(8)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`;
  if (c.status !== "PASS" && c.status !== "INFO" && c.fix) line += `\n         fix: ${c.fix}`;
  return line;
}

/** A doctor run fails on FAIL, MISSING or UNKNOWN; PASS, WARN and INFO do not fail it. */
export function failed(checks: Check[]): boolean {
  return checks.some((c) => c.status === "FAIL" || c.status === "MISSING" || c.status === "UNKNOWN");
}

/** Counts per status, then every check that did not pass grouped under its fix, in first-seen order. */
export function summary(checks: Check[]): string[] {
  const counts = new Map<Status, number>();
  for (const c of checks) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const order: Status[] = ["PASS", "FAIL", "MISSING", "UNKNOWN", "WARN", "INFO"];
  const lines = [`${checks.length} checks: ${order.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${s.toLowerCase()}`).join(", ")}`];
  const groups = new Map<string, string[]>();
  for (const c of checks) {
    if (c.status === "PASS" || c.status === "INFO") continue;
    const key = c.fix ?? "(no fix recorded)";
    groups.set(key, [...(groups.get(key) ?? []), `${c.name} (${c.status})`]);
  }
  if (groups.size > 0) {
    // In README step order (the first step a fix cites); fixes that cite no step keep their order at the end.
    const firstStep = (fix: string) => Number(/step (\d+)/.exec(fix)?.[1] ?? 99);
    const ordered = [...groups].map((g, i) => ({ g, i })).sort((a, b) => firstStep(a.g[0]) - firstStep(b.g[0]) || a.i - b.i);
    lines.push("Not passing, grouped by fix in README step order:");
    for (const { g: [fix, names] } of ordered) lines.push(`  ${fix}`, ...names.map((n) => `    - ${n}`));
  }
  return lines;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.replace(/^v/, "").split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// --- read-only guard ---------------------------------------------------------------------------------

/** The wrangler subcommands the doctor may run (prefixes after `wrangler`). */
export const READ_ONLY_WRANGLER: readonly (readonly string[])[] = [
  ["--version"],
  ["whoami"],
  ["auth", "token"],
  ["r2", "bucket", "list"],
  ["basin", "catalog", "get"],
  ["queues", "info"],
  ["deployments", "list"],
  ["secret", "list"],
];
/** Every other command the doctor may run (prefixes of the whole argument list). */
export const READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  ["npm", "--version"],
  ["uv", "--version"],
  ["which"],
  ["uv", "run", "--project", "pipeline", "python", "--version"],
  ["uv", "run", "--project", "pipeline", "peoplelake", "lake", "status"],
  ["uv", "run", "--project", "pipeline", "peoplelake", "prod", "doctor-gcp"],
];

const startsWith = (argv: readonly string[], prefix: readonly string[]) => prefix.every((x, i) => argv[i] === x);

export function doctorCommandAllowed(argv: string[]): boolean {
  const [cmd, ...rest] = argv;
  if (cmd === "wrangler" || cmd?.endsWith("/wrangler")) return READ_ONLY_WRANGLER.some((p) => startsWith(rest, p));
  return READ_ONLY_COMMANDS.some((p) => startsWith(argv, p));
}

export interface DoctorDeps {
  exec: Exec;
  /** Cloudflare API with a bearer token; the doctor only ever sends GET. */
  http: Http;
  /** A GET to a public URL (team domain, workers.dev), optionally with service-token headers. */
  probe: (url: string, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;
}

const realProbe: DoctorDeps["probe"] = async (url, headers) => {
  try {
    const res = await fetch(url, { headers: headers ?? {}, redirect: "manual" });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
};

export const realDeps: DoctorDeps = { exec: realExec, http: realHttp, probe: realProbe };

/** Wraps the dependencies so that nothing but read commands and GET requests can leave the doctor. */
export function readOnly(deps: DoctorDeps): DoctorDeps {
  return {
    exec: (argv, opts) => {
      if (!doctorCommandAllowed(argv)) throw new Error(`the doctor runs read-only commands only, not: ${argv.slice(0, 4).join(" ")}`);
      return deps.exec(argv, opts);
    },
    http: (method, url, token, body) => {
      if (method !== "GET") throw new Error(`the doctor only sends GET requests, not ${method} ${url}`);
      return deps.http(method, url, token, body);
    },
    probe: deps.probe,
  };
}

// --- local --------------------------------------------------------------------------------------------

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** npm scripts that run node, vitest or uv (or name a node config) without a leading TZ=UTC (SPEC 3.5). */
export function scriptsMissingTz(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([, cmd]) => /\b(node|vitest|uv)\b/.test(cmd) && !cmd.startsWith("TZ=UTC"))
    .map(([name]) => name);
}

export async function localChecks(root: string, deps: DoctorDeps = readOnly(realDeps)): Promise<Check[]> {
  const sh = (argv: string[]) => {
    const r = deps.exec(argv, {});
    return { ok: r.ok, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const out: Check[] = [];
  out.push(
    versionAtLeast(process.version, "22.18.0")
      ? { name: "node >= 22.18", status: "PASS", detail: process.version }
      : { name: "node >= 22.18", status: "FAIL", detail: process.version, fix: "install Node 24 LTS (see .nvmrc)" },
  );
  const npm = sh(["npm", "--version"]);
  out.push(npm.ok ? { name: "npm", status: "PASS", detail: npm.out } : { name: "npm", status: "MISSING", fix: "install Node with npm" });
  const uv = sh(["uv", "--version"]);
  out.push(
    uv.ok && /uv 0\.12\./.test(uv.out)
      ? { name: "uv 0.12.x", status: "PASS", detail: uv.out }
      : { name: "uv 0.12.x", status: uv.ok ? "FAIL" : "MISSING", detail: uv.out, fix: "brew install uv (0.12.x)" },
  );
  const py = sh(["uv", "run", "--project", "pipeline", "python", "--version"]);
  out.push(
    py.ok && py.out.includes("3.12")
      ? { name: "Python 3.12 (pipeline)", status: "PASS", detail: py.out.split("\n").pop() ?? "" }
      : { name: "Python 3.12 (pipeline)", status: "FAIL", detail: py.out.slice(0, 200), fix: "uv sync --locked --project pipeline" },
  );
  const wr = sh([join(root, "node_modules", ".bin", "wrangler"), "--version"]);
  out.push(
    wr.ok && wr.out.includes("4.149.0")
      ? { name: "wrangler 4.149.0 (node_modules)", status: "PASS" }
      : { name: "wrangler 4.149.0 (node_modules)", status: "MISSING", detail: wr.out.slice(0, 100), fix: "npm ci" },
  );
  const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const noTz = scriptsMissingTz(scripts);
  out.push(
    noTz.length === 0
      ? { name: "TZ=UTC in npm scripts", status: "PASS" }
      : { name: "TZ=UTC in npm scripts", status: "FAIL", detail: noTz.join(", "), fix: "prefix those scripts with TZ=UTC" },
  );
  for (const port of [8791, 9241, 8150]) {
    out.push(
      (await portFree(port))
        ? { name: `port ${port} free`, status: "PASS" }
        : { name: `port ${port} free`, status: "WARN", detail: "in use", fix: "uv run --project pipeline peoplelake stack down" },
    );
  }
  const devVars = readEnvFile(join(root, ".dev.vars"));
  out.push(
    devVars["DEV_ACCESS_JWKS"] && existsSync(join(root, ".dev", "keys", "private.pem"))
      ? { name: "dev keys and .dev.vars", status: "PASS" }
      : { name: "dev keys and .dev.vars", status: "MISSING", fix: "uv run --project pipeline peoplelake auth dev-keys" },
  );
  out.push(...freePlanChecks(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
  const llama = sh(["which", "llama-server"]);
  const gguf = join(homedir(), "Developer", "projects", "_models", "Qwen3-1.7B-Q4_0-rtn.gguf");
  out.push({
    name: "llama-server and Qwen3-1.7B GGUF (optional, local LLM)",
    status: "INFO",
    detail: `${llama.ok ? "llama-server found" : "llama-server not found"}, ${existsSync(gguf) ? "GGUF found" : "GGUF not found"}; the deterministic stub is used otherwise`,
  });
  return out;
}

/** The Workers Free plan rules and the budget estimates for a wrangler config (offline). */
export function freePlanChecks(configText: string): Check[] {
  const problems = freePlanConfigProblems(configText);
  const over = overBudget(budgetRows(budgetInputsFromConfig(configText)));
  return [
    problems.length === 0
      ? { name: "Workers Free plan rules (no pipelines or limits, one */5 cron, SQLite Durable Objects, guard values)", status: "PASS" }
      : { name: "Workers Free plan rules", status: "FAIL", detail: problems.join("; "), fix: "fix wrangler.jsonc (SPEC 29.6)" },
    over.length === 0
      ? { name: "Free plan budget estimates within the planning shares", status: "PASS", detail: "npm run budget" }
      : { name: "Free plan budget estimates within the planning shares", status: "FAIL", detail: over.map((r) => r.label).join(", "), fix: "npm run budget" },
  ];
}

interface OpsBudget {
  durable_objects?: { rows_read_today?: number; rows_written_today?: number };
  runs?: { automatic_today?: number; automatic_max_per_day?: number; consecutive_failures?: number; failure_backoff_until?: number | null; workflow_steps_today?: number };
  workers_ai?: { neurons_today?: number; cap?: number };
  bigquery?: { bytes_billed?: number; cap_bytes?: number; month?: string };
}

/** Production's GET /api/ops/budget against this repo's planning shares (SPEC 29.5). */
export function opsBudgetChecks(b: OpsBudget): Check[] {
  const share = (allowance: number) => Math.floor(allowance * CLOUDFLARE_PLANNING_SHARE);
  const within = (name: string, used: number, limit: number, unit: string): Check => ({
    name,
    status: used <= limit ? "PASS" : "WARN",
    detail: `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} ${unit}`,
    fix: "GET /api/ops/budget; the Free plan allowances are shared with the other Workers on the account",
  });
  const runs = b.runs ?? {};
  return [
    within("Durable Object rows read today", b.durable_objects?.rows_read_today ?? 0, share(5_000_000), "rows (20% of 5,000,000)"),
    within("Durable Object rows written today", b.durable_objects?.rows_written_today ?? 0, share(100_000), "rows (20% of 100,000)"),
    within("Workflow steps today", runs.workflow_steps_today ?? 0, share(3_000), "steps (20% of 3,000)"),
    within("automatic runs today", runs.automatic_today ?? 0, runs.automatic_max_per_day ?? 30, "(daily cap)"),
    within("Workers AI neurons today", b.workers_ai?.neurons_today ?? 0, b.workers_ai?.cap ?? 1_800, "neurons (daily cap)"),
    within(`BigQuery bytes billed this month (${b.bigquery?.month ?? "?"})`, b.bigquery?.bytes_billed ?? 0, b.bigquery?.cap_bytes ?? 274_000_000_000, "bytes (monthly guard)"),
    (runs.consecutive_failures ?? 0) > 0
      ? { name: "failure backoff", status: "WARN", detail: `${runs.consecutive_failures} consecutive failed runs; automatic runs wait until ${new Date(runs.failure_backoff_until ?? 0).toISOString()}`, fix: "GET /api/runs to see the error" }
      : { name: "failure backoff", status: "PASS", detail: "no consecutive failures" },
  ];
}

// --- .prod files ----------------------------------------------------------------------------------------

/** Secrets a person creates (README steps 2 and 3); setup:prod writes the service token ones. */
export const PERSON_SECRETS = { PL_R2_CATALOG_TOKEN: README_STEP.catalogToken, PL_CF_SETUP_TOKEN: README_STEP.setupToken } as const;

export function prodFileChecks(root: string): Check[] {
  const prod = join(root, ".prod");
  const out: Check[] = [];
  for (const f of ["config.env", "secrets.env", "state.json", "gcp.json", "gcp-dispatcher-key.json"]) {
    const p = join(prod, f);
    if (!existsSync(p)) {
      if (f.endsWith(".env")) out.push({ name: `.prod/${f}`, status: "MISSING", detail: "not present yet", fix: PROD_FILES_FIX });
      else out.push({ name: `.prod/${f}`, status: "INFO", detail: "not present yet; npm run setup:prod writes it" });
      continue;
    }
    const loose = (statSync(p).mode & 0o077) !== 0;
    out.push(loose ? { name: `.prod/${f} mode`, status: "WARN", detail: "group or world readable", fix: `chmod 600 .prod/${f}` } : { name: `.prod/${f} mode 600`, status: "PASS" });
  }
  const secrets = readEnvFile(join(prod, "secrets.env"));
  for (const [name, n] of Object.entries(PERSON_SECRETS)) {
    out.push(secrets[name] ? { name: `secret ${name} (name only)`, status: "PASS" } : { name: `secret ${name}`, status: "MISSING", detail: "not in .prod/secrets.env", fix: `${step(n)} (then save it in .prod/secrets.env)` });
  }
  const written = Object.values(SERVICE_TOKENS).flatMap((t) => [`${t.env}_CLIENT_ID`, `${t.env}_CLIENT_SECRET`]);
  const missing = written.filter((n) => !secrets[n]);
  out.push(
    missing.length === 0
      ? { name: "service token secrets written by setup (names only)", status: "PASS" }
      : { name: "service token secrets written by setup", status: "MISSING", detail: `${missing.length} of ${written.length} not in .prod/secrets.env`, fix: SETUP_FIX },
  );
  return out;
}

/** `.prod/config.env` with PL_* environment variables taking precedence. */
export function doctorConfig(root: string, env: Record<string, string | undefined>): Record<string, string> {
  const fromEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith("PL_") && v) as [string, string][]);
  return { ...readEnvFile(join(root, ".prod", "config.env")), ...fromEnv };
}

/** True when `text` lists `name` as a whole name (not as the prefix of a longer one such as `x-dlq`). */
export function listsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

// --- Cloudflare -----------------------------------------------------------------------------------------

export interface DoctorOptions {
  /** One runner execution through the deployed Worker (a token exchange, a Cloud Run execution). */
  withDispatch?: boolean;
  /** One live Workers AI call (about 3 neurons of the account's daily allowance, one gateway log entry). */
  withAi?: boolean;
  env?: Record<string, string | undefined>;
}

/** The live Worker paths the doctor probes; without the opt-in flags none of them changes anything. */
export function opsProbePath(kind: "ai" | "dispatch", opts: DoctorOptions): string {
  if (kind === "ai") return `/api/ops/ai${opts.withAi ? "?live=1" : ""}`;
  return `/api/ops/dispatch${opts.withDispatch ? "?execute=1" : ""}`;
}

export async function cloudflareChecks(root: string, deps: DoctorDeps, opts: DoctorOptions = {}): Promise<Check[]> {
  const out: Check[] = [];
  const config = doctorConfig(root, opts.env ?? {});
  const secrets = readEnvFile(join(root, ".prod", "secrets.env"));
  const statePath = join(root, ".prod", "state.json");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as ProdState) : null;
  let account = config["PL_CF_ACCOUNT_ID"] || state?.account_id || "";
  const wrangler = (args: string[]) => {
    const r = deps.exec([join(root, "node_modules", ".bin", "wrangler"), ...args], account ? { env: { CLOUDFLARE_ACCOUNT_ID: account } } : {});
    return { ok: r.ok, out: stripVTControlCharacters(`${r.stdout}\n${r.stderr}`).trim(), stdout: r.stdout };
  };

  // Login and account
  const who = wrangler(["whoami", "--json"]);
  let whoami: { loggedIn?: boolean; accounts?: { id: string }[] } = {};
  try {
    whoami = JSON.parse(who.stdout) as typeof whoami;
  } catch {
    whoami = {};
  }
  if (!who.ok || !whoami.loggedIn) {
    out.push({ name: "wrangler login", status: "MISSING", fix: "npx wrangler login" });
    return out;
  }
  out.push({ name: "wrangler login (OAuth)", status: "PASS" });
  const accounts = (whoami.accounts ?? []).map((a) => a.id);
  if (account) {
    out.push(
      accounts.includes(account)
        ? { name: "Cloudflare account (PL_CF_ACCOUNT_ID) in the wrangler login", status: "PASS" }
        : { name: "Cloudflare account (PL_CF_ACCOUNT_ID) in the wrangler login", status: "FAIL", detail: "not one of the login's accounts", fix: "set PL_CF_ACCOUNT_ID to the Account ID npx wrangler whoami prints" },
    );
  } else if (accounts.length === 1 && accounts[0]) {
    account = accounts[0];
    out.push({ name: "Cloudflare account", status: "INFO", detail: "PL_CF_ACCOUNT_ID is not set; checking the login's only account" });
  } else {
    out.push({ name: "Cloudflare account", status: "MISSING", detail: `PL_CF_ACCOUNT_ID is not set and the login has ${accounts.length} accounts`, fix: PROD_FILES_FIX });
    return out;
  }

  // workers.dev subdomain: wrangler's own OAuth token, one GET, never printed.
  let subdomain = "";
  const tokenOut = wrangler(["auth", "token", "--json"]);
  let oauth = "";
  try {
    oauth = (JSON.parse(tokenOut.stdout) as { token?: string }).token ?? "";
  } catch {
    oauth = "";
  }
  if (oauth) {
    const got = await deps.http("GET", `${API}/accounts/${account}/workers/subdomain`, oauth);
    subdomain = (got.json?.result?.subdomain as string | undefined) ?? "";
    const wanted = config["PL_WORKERS_SUBDOMAIN"] ?? "";
    if (subdomain && wanted && wanted !== subdomain) out.push({ name: "workers.dev subdomain", status: "WARN", detail: `the account's is ${subdomain}, PL_WORKERS_SUBDOMAIN says ${wanted}`, fix: `set PL_WORKERS_SUBDOMAIN=${subdomain} (setup uses the account's anyway)` });
    else if (subdomain) out.push({ name: "workers.dev subdomain", status: "PASS", detail: `${subdomain}.workers.dev` });
    else out.push({ name: "workers.dev subdomain", status: "MISSING", detail: `HTTP ${got.status}`, fix: "register one in the dashboard: Workers & Pages, Overview, Subdomain (Workflows need one)" });
  } else {
    out.push({ name: "workers.dev subdomain", status: "UNKNOWN", detail: "wrangler auth token returned no OAuth token", fix: "npx wrangler login" });
  }
  subdomain ||= state?.workers_subdomain ?? "";

  // R2 buckets and Basin Catalog
  const buckets = wrangler(["r2", "bucket", "list"]);
  const bucketPresent = new Map<string, boolean>();
  if (!buckets.ok) {
    const r2Off = /enable R2|10042/i.test(buckets.out);
    out.push({ name: "R2", status: r2Off ? "MISSING" : "UNKNOWN", detail: r2Off ? "R2 is not enabled on the account" : buckets.out.split("\n")[0]?.slice(0, 160), fix: "enable R2 with a payment card in the dashboard (R2, Overview)" });
  } else {
    for (const b of [LAKE_BUCKET, REPORTS_BUCKET]) {
      const present = bucketListed(buckets.out, b);
      bucketPresent.set(b, present);
      out.push(present ? { name: `R2 bucket ${b}`, status: "PASS" } : { name: `R2 bucket ${b}`, status: "MISSING", fix: SETUP_FIX });
    }
  }
  if (bucketPresent.get(LAKE_BUCKET)) {
    const catalog = wrangler(["basin", "catalog", "get", LAKE_BUCKET]);
    out.push(catalog.ok && !/not enabled|disabled/i.test(catalog.out) ? { name: `Basin Catalog on ${LAKE_BUCKET}`, status: "PASS" } : { name: `Basin Catalog on ${LAKE_BUCKET}`, status: "MISSING", fix: SETUP_FIX });
  } else {
    out.push({ name: `Basin Catalog on ${LAKE_BUCKET}`, status: "MISSING", detail: "the bucket does not exist yet", fix: SETUP_FIX });
  }
  const lakeEnv = {
    PL_R2_CATALOG_URI: config["PL_R2_CATALOG_URI"] || state?.catalog.uri || "",
    PL_R2_WAREHOUSE: config["PL_R2_WAREHOUSE"] || state?.catalog.warehouse || "",
    PL_R2_CATALOG_TOKEN: secrets["PL_R2_CATALOG_TOKEN"] ?? "",
  };
  const lakeNeeds = Object.entries(lakeEnv).filter(([, v]) => !v).map(([k]) => k);
  if (lakeNeeds.length > 0) {
    out.push({ name: "Iceberg table peoplelake.raw_events", status: "MISSING", detail: `not checkable yet: needs ${lakeNeeds.join(", ")}`, fix: SETUP_FIX });
  } else {
    const lakeCli = deps.exec(["uv", "run", "--project", "pipeline", "peoplelake", "lake", "status", "--target", "prod"], { env: lakeEnv });
    let lakeStatus: { exists?: boolean; landing_cursor?: string | null } = {};
    try {
      lakeStatus = JSON.parse(lakeCli.stdout.trim().split("\n").pop() ?? "{}") as typeof lakeStatus;
    } catch {
      lakeStatus = {};
    }
    out.push(
      lakeStatus.exists
        ? { name: "Iceberg table peoplelake.raw_events", status: "PASS", detail: `landing cursor ${lakeStatus.landing_cursor ?? "none yet"}` }
        : { name: "Iceberg table peoplelake.raw_events", status: "MISSING", detail: `${lakeCli.stdout}${lakeCli.stderr}`.trim().slice(0, 200), fix: SETUP_FIX },
    );
  }

  // Queues (`queues info` looks the name up directly; `queues list` is paginated)
  for (const q of QUEUES) {
    const info = wrangler(["queues", "info", q]);
    if (info.ok && queueInfoNames(info.out, q)) out.push({ name: `queue ${q}`, status: "PASS" });
    else if (info.ok) out.push({ name: `queue ${q}`, status: "MISSING", detail: "wrangler found a different queue", fix: SETUP_FIX });
    else if (/does not exist/i.test(info.out)) out.push({ name: `queue ${q}`, status: "MISSING", fix: SETUP_FIX });
    else out.push({ name: `queue ${q}`, status: "UNKNOWN", detail: info.out.split("\n")[0]?.slice(0, 160) ?? "", fix: SETUP_FIX });
  }

  // Zero Trust: the team domain publishes its signing keys (public, no token).
  const team = config["PL_ACCESS_TEAM_DOMAIN"] || state?.access.team_domain || "";
  if (team) {
    const certs = await deps.probe(`${team.replace(/\/$/, "")}/cdn-cgi/access/certs`);
    const keys = (certs.json as { keys?: unknown[] } | null)?.keys ?? [];
    out.push(certs.status === 200 && keys.length > 0 ? { name: "Zero Trust team domain", status: "PASS", detail: `${keys.length} signing keys published` } : { name: "Zero Trust team domain", status: "FAIL", detail: `certs HTTP ${certs.status}`, fix: "check PL_ACCESS_TEAM_DOMAIN against Zero Trust, Settings (team domain)" });
  } else {
    out.push({ name: "Zero Trust team domain", status: "MISSING", detail: "PL_ACCESS_TEAM_DOMAIN is not set", fix: PROD_FILES_FIX });
  }

  // Access and AI Gateway through the setup token (wrangler's OAuth login has no Access or AI Gateway scopes).
  const setupToken = secrets["PL_CF_SETUP_TOKEN"] ?? "";
  if (!setupToken) {
    // wrangler's OAuth login cannot read Access or AI Gateway, so these wait for the setup token.
    out.push({ name: "One-time PIN login method", status: "UNKNOWN", detail: "not checkable without PL_CF_SETUP_TOKEN", fix: `${step(README_STEP.onetimePin)}: Zero Trust, Integrations, Identity providers, One-time PIN` });
    out.push({ name: "Access service tokens, AI Gateway and the Access application", status: "UNKNOWN", detail: "not checkable without PL_CF_SETUP_TOKEN; setup creates them", fix: SETUP_FIX });
  } else {
    const verify = await deps.http("GET", `${API}/user/tokens/verify`, setupToken);
    out.push(verify.ok && verify.json?.result?.status === "active" ? { name: "PL_CF_SETUP_TOKEN active", status: "PASS" } : { name: "PL_CF_SETUP_TOKEN active", status: "FAIL", detail: `HTTP ${verify.status}`, fix: step(README_STEP.setupToken) });
    const idps = await deps.http("GET", `${API}/accounts/${account}/access/identity_providers`, setupToken);
    if (idps.ok) {
      const types = ((idps.json?.result ?? []) as { type?: string }[]).map((i) => i.type);
      out.push(types.includes("onetimepin") ? { name: "One-time PIN login method", status: "PASS" } : { name: "One-time PIN login method", status: "MISSING", fix: `${step(README_STEP.onetimePin)}: Zero Trust, Integrations, Identity providers, One-time PIN` });
    } else {
      out.push({ name: "One-time PIN login method", status: "WARN", detail: `cannot read identity providers with PL_CF_SETUP_TOKEN (HTTP ${idps.status})`, fix: `check Zero Trust, Integrations, Identity providers, or add Access: Organizations, Identity Providers, and Groups Read to the token (${step(README_STEP.setupToken)})` });
    }
    const tokens = await deps.http("GET", `${API}/accounts/${account}/access/service_tokens`, setupToken);
    const tokenNames = new Set(((tokens.json?.result ?? []) as { name: string }[]).map((t) => t.name));
    const missingTokens = Object.keys(SERVICE_TOKENS).filter((n) => !tokenNames.has(n));
    out.push(tokens.ok ? (missingTokens.length === 0 ? { name: "Access service tokens (5)", status: "PASS" } : { name: "Access service tokens", status: "MISSING", detail: missingTokens.join(", "), fix: SETUP_FIX }) : { name: "Access service tokens", status: "UNKNOWN", detail: `HTTP ${tokens.status}`, fix: step(README_STEP.setupToken) });
    const gateway = await deps.http("GET", `${API}/accounts/${account}/ai-gateway/gateways/${GATEWAY}`, setupToken);
    out.push(gateway.ok ? { name: `AI Gateway ${GATEWAY}`, status: "PASS" } : { name: `AI Gateway ${GATEWAY}`, status: gateway.status === 404 ? "MISSING" : "UNKNOWN", detail: `HTTP ${gateway.status}`, fix: SETUP_FIX });
    const apps = await deps.http("GET", `${API}/accounts/${account}/access/apps`, setupToken);
    const app = ((apps.json?.result ?? []) as { name: string; aud?: string }[]).find((a) => a.name === WORKER);
    out.push(apps.ok ? (app ? { name: "Access application peoplelake", status: "PASS" } : { name: "Access application peoplelake", status: "MISSING", fix: SETUP_FIX }) : { name: "Access application peoplelake", status: "UNKNOWN", detail: `HTTP ${apps.status}`, fix: step(README_STEP.setupToken) });
    if (app) {
      const cookie = accessCookieProblems(app as unknown as Record<string, unknown>);
      out.push(
        cookie.length === 0
          ? { name: "Access session cookie SameSite Lax and HttpOnly", status: "PASS" }
          : { name: "Access session cookie settings", status: "FAIL", detail: cookie.join("; "), fix: "Zero Trust, Access, Applications, peoplelake, Settings, Cookie settings: SameSite Lax, HttpOnly on" },
      );
    }
    if (app && state && app.aud !== state.access.aud) out.push({ name: "Access AUD in .prod/state.json", status: "FAIL", detail: "differs from the application's", fix: "npm run setup:prod -- --only cloudflare, then npm run deploy" });
  }

  // The deployed Worker and its live checks
  const deployed = wrangler(["deployments", "list", "--name", WORKER]);
  if (!deployed.ok) {
    out.push({ name: `Worker ${WORKER} deployed`, status: "MISSING", fix: SETUP_FIX });
    out.push({ name: "live checks (Access in front of the Worker, service token roles, landing, budget, Workers AI, dispatch)", status: "INFO", detail: "run once the Worker is deployed" });
    return out;
  }
  out.push({ name: `Worker ${WORKER} deployed`, status: "PASS" });
  const rendered = join(root, "wrangler.production.jsonc");
  if (existsSync(rendered)) {
    const problems = freePlanConfigProblems(readFileSync(rendered, "utf8"));
    out.push(problems.length === 0 ? { name: "rendered production config needs nothing from Workers Paid", status: "PASS" } : { name: "rendered production config", status: "FAIL", detail: problems.join("; "), fix: "npm run deploy re-renders it from wrangler.jsonc" });
  }
  const secretList = wrangler(["secret", "list", "--name", WORKER]).out;
  out.push(listsName(secretList, "GCP_DISPATCHER_KEY") ? { name: "Worker secret GCP_DISPATCHER_KEY (name only)", status: "PASS" } : { name: "Worker secret GCP_DISPATCHER_KEY", status: "MISSING", fix: "npm run setup:prod -- --only worker" });
  out.push(state?.runs_enabled ? { name: "RUNS_ENABLED", status: "PASS" } : { name: "RUNS_ENABLED", status: "FAIL", detail: "false (fail-closed until the Google Cloud bootstrap passes)", fix: "npm run setup:prod -- --only gcp, then --only worker" });
  if (!subdomain) return out;

  const url = `https://${WORKER}.${subdomain}.workers.dev`;
  const anon = await deps.probe(`${url}/v1/health`);
  const answeredByAccess = anon.status === 401 || anon.status === 403 || (anon.status >= 300 && anon.status < 400);
  out.push(answeredByAccess ? { name: "Access in front of the Worker", status: "PASS", detail: `unauthenticated /v1/health -> ${anon.status}` } : { name: "Access in front of the Worker", status: "FAIL", detail: `unauthenticated /v1/health -> ${anon.status || "no response"}`, fix: "npm run setup:prod -- --only cloudflare (Access application)" });
  const headers = (env: string) => ({ "CF-Access-Client-Id": secrets[`${env}_CLIENT_ID`] ?? "", "CF-Access-Client-Secret": secrets[`${env}_CLIENT_SECRET`] ?? "" });
  for (const [name, meta] of Object.entries(SERVICE_TOKENS)) {
    const res = await deps.probe(`${url}/v1/health/auth`, headers(meta.env));
    const roles = res.status === 200 ? ((res.json as { roles?: string[] } | null)?.roles ?? []) : [];
    out.push(roles.includes(meta.role) ? { name: `service token ${name} -> ${meta.role}`, status: "PASS" } : { name: `service token ${name} -> ${meta.role}`, status: "FAIL", detail: `HTTP ${res.status || "none"}`, fix: "npm run setup:prod (tokens, Access policy, role map)" });
  }
  const wrong = await deps.probe(`${url}/v1/health/auth`, { "CF-Access-Client-Id": secrets["PL_CF_RUNNER_CLIENT_ID"] ?? "x", "CF-Access-Client-Secret": "wrong-secret" });
  out.push([401, 403].includes(wrong.status) || (wrong.status >= 300 && wrong.status < 400) ? { name: "wrong service token secret rejected", status: "PASS" } : { name: "wrong service token secret rejected", status: "FAIL", detail: `HTTP ${wrong.status || "none"}` });
  const op = headers("PL_CF_DOCTOR");
  const lake = await deps.probe(`${url}/api/ops/lake`, op);
  const landing = lake.status === 200 ? (lake.json as { landing?: { landed_through?: string | null } } | null)?.landing : undefined;
  out.push(landing ? { name: "landing (LandingRoller)", status: "PASS", detail: `landed through ${landing.landed_through ?? "nothing yet"}` } : { name: "landing (LandingRoller)", status: "FAIL", detail: `HTTP ${lake.status || "none"}`, fix: "npm run deploy" });
  const budget = await deps.probe(`${url}/api/ops/budget`, op);
  if (budget.status === 200 && budget.json) out.push(...opsBudgetChecks(budget.json as OpsBudget));
  else out.push({ name: "GET /api/ops/budget", status: "FAIL", detail: `HTTP ${budget.status || "none"}`, fix: "npm run deploy" });
  // Side-effect free unless asked: the default AI check reads the binding and settings (no model call, no
  // neurons, no gateway log), the default dispatch check parses the key (no token exchange, no write).
  const ai = await deps.probe(`${url}${opsProbePath("ai", opts)}`, op);
  const aiJson = ai.json as { ok?: boolean; gateway_log_id_present?: boolean } | null;
  out.push(
    (opts.withAi ? aiJson?.gateway_log_id_present : aiJson?.ok)
      ? { name: opts.withAi ? "Workers AI through AI Gateway (one live call)" : "Workers AI binding, model and gateway configured", status: "PASS", ...(opts.withAi ? {} : { detail: "--with-ai makes one live call" }) }
      : { name: "Workers AI through AI Gateway", status: "FAIL", detail: `HTTP ${ai.status || "none"}`, fix: "npm run setup:prod (AI Gateway peoplelake)" },
  );
  const dispatch = await deps.probe(`${url}${opsProbePath("dispatch", opts)}`, op);
  out.push((dispatch.json as { ok?: boolean } | null)?.ok ? { name: opts.withDispatch ? "Cloud Run dispatch token and one execution" : "Cloud Run dispatcher key", status: "PASS" } : { name: "Cloud Run dispatch", status: "FAIL", detail: `HTTP ${dispatch.status || "none"}`, fix: "check GCP_DISPATCHER_KEY (npm run setup:prod -- --only worker)" });
  return out;
}

/** `peoplelake prod doctor-gcp --json`, merged into this doctor's checks. */
export function gcpChecks(deps: DoctorDeps): Check[] {
  const res = deps.exec(["uv", "run", "--project", "pipeline", "peoplelake", "prod", "doctor-gcp", "--json"], {});
  try {
    const rows = JSON.parse(res.stdout.trim().split("\n").pop() ?? "") as { name: string; status: Status; detail: string; fix: string }[];
    return rows.map((r) => ({ name: r.name, status: r.status, ...(r.detail ? { detail: r.detail } : {}), ...(r.fix ? { fix: r.fix } : {}) }));
  } catch {
    return [{ name: "peoplelake prod doctor-gcp", status: "UNKNOWN", detail: `${res.stdout}${res.stderr}`.trim().slice(-300), fix: "uv sync --locked --project pipeline" }];
  }
}

async function main(): Promise<number> {
  const root = process.cwd();
  const localOnly = process.argv.includes("--local-only");
  const quick = process.argv.includes("--quick");
  const deps = readOnly(realDeps);
  const sections: [string, Check[]][] = [["Local", await localChecks(root, deps)]];
  if (!localOnly) {
    sections.push([".prod files", prodFileChecks(root)]);
    sections.push(["Cloudflare", await cloudflareChecks(root, deps, { withDispatch: process.argv.includes("--with-dispatch"), withAi: process.argv.includes("--with-ai"), env: process.env })]);
    if (!quick) sections.push(["Google Cloud (peoplelake prod doctor-gcp)", gcpChecks(deps)]);
  }
  for (const [title, checks] of sections) {
    console.log(`\n${title}`);
    for (const c of checks) console.log(format(c));
  }
  const all = sections.flatMap(([, checks]) => checks);
  console.log(`\n${summary(all).join("\n")}`);
  return failed(all) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
