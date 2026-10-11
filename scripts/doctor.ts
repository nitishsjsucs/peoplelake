// npm run doctor [-- --local-only | --quick | --with-dispatch]
//
// Checks every prerequisite (SPEC 21.3 and 21.0) and prints PASS, FAIL, MISSING, UNKNOWN, WARN or INFO per
// check, with the exact command or console step for every non-pass. Never prints secret values, only names.
// Workers Free plan: the config must need nothing from Workers Paid (no pipelines, no limits, one cron,
// SQLite Durable Objects), the budget estimates must stay within the planning shares, and production's
// GET /api/ops/budget is printed against them. After the Cloudflare checks it runs
// `peoplelake prod doctor-gcp` (unless --local-only).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetRows, CLOUDFLARE_PLANNING_SHARE, overBudget } from "../src/shared/free-budget.ts";
import { budgetInputsFromConfig, freePlanConfigProblems } from "./lib/free-plan.ts";
import type { ProdState } from "./lib/prod-state.ts";
import { LAKE_BUCKET, QUEUES, readEnvFile, REPORTS_BUCKET, SERVICE_TOKENS } from "./setup-prod.ts";

export type Status = "PASS" | "FAIL" | "MISSING" | "UNKNOWN" | "WARN" | "INFO";
export interface Check {
  name: string;
  status: Status;
  detail?: string;
  fix?: string;
}

export function format(c: Check): string {
  let line = `${c.status.padEnd(8)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`;
  if (c.status !== "PASS" && c.status !== "INFO" && c.fix) line += `\n         fix: ${c.fix}`;
  return line;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.replace(/^v/, "").split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function sh(cmd: string, args: string[], cwd: string, env?: Record<string, string>) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

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

export async function localChecks(root: string): Promise<Check[]> {
  const out: Check[] = [];
  out.push(
    versionAtLeast(process.version, "22.18.0")
      ? { name: "node >= 22.18", status: "PASS", detail: process.version }
      : { name: "node >= 22.18", status: "FAIL", detail: process.version, fix: "install Node 24 LTS (see .nvmrc)" },
  );
  const npm = sh("npm", ["--version"], root);
  out.push(npm.ok ? { name: "npm", status: "PASS", detail: npm.out } : { name: "npm", status: "MISSING", fix: "install Node with npm" });
  const uv = sh("uv", ["--version"], root);
  out.push(
    uv.ok && /uv 0\.12\./.test(uv.out)
      ? { name: "uv 0.12.x", status: "PASS", detail: uv.out }
      : { name: "uv 0.12.x", status: uv.ok ? "FAIL" : "MISSING", detail: uv.out, fix: "brew install uv (0.12.x)" },
  );
  const py = sh("uv", ["run", "--project", "pipeline", "python", "--version"], root);
  out.push(
    py.ok && py.out.includes("3.12")
      ? { name: "Python 3.12 (pipeline)", status: "PASS", detail: py.out.split("\n").pop() ?? "" }
      : { name: "Python 3.12 (pipeline)", status: "FAIL", detail: py.out.slice(0, 200), fix: "uv sync --locked --project pipeline" },
  );
  const wr = sh(join(root, "node_modules", ".bin", "wrangler"), ["--version"], root);
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
  const llama = sh("which", ["llama-server"], root);
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
    within(`BigQuery bytes billed this month (${b.bigquery?.month ?? "?"})`, b.bigquery?.bytes_billed ?? 0, b.bigquery?.cap_bytes ?? 275_000_000_000, "bytes (monthly guard)"),
    (runs.consecutive_failures ?? 0) > 0
      ? { name: "failure backoff", status: "WARN", detail: `${runs.consecutive_failures} consecutive failed runs; automatic runs wait until ${new Date(runs.failure_backoff_until ?? 0).toISOString()}`, fix: "GET /api/runs to see the error" }
      : { name: "failure backoff", status: "PASS", detail: "no consecutive failures" },
  ];
}

export function prodFileChecks(root: string): Check[] {
  const prod = join(root, ".prod");
  const out: Check[] = [];
  for (const f of ["config.env", "secrets.env", "state.json", "gcp.json", "gcp-dispatcher-key.json"]) {
    const p = join(prod, f);
    if (!existsSync(p)) {
      out.push({ name: `.prod/${f}`, status: f.endsWith(".env") ? "MISSING" : "INFO", detail: "not present yet", fix: "README production setup, step 12 and npm run setup:prod" });
      continue;
    }
    const loose = (statSync(p).mode & 0o077) !== 0;
    out.push(loose ? { name: `.prod/${f} mode`, status: "WARN", detail: "group or world readable", fix: `chmod 600 .prod/${f}` } : { name: `.prod/${f} mode 600`, status: "PASS" });
  }
  const secrets = readEnvFile(join(prod, "secrets.env"));
  const names = ["PL_CF_SETUP_TOKEN", "PL_R2_CATALOG_TOKEN", ...Object.values(SERVICE_TOKENS).flatMap((t) => [`${t.env}_CLIENT_ID`, `${t.env}_CLIENT_SECRET`])];
  const missing = names.filter((n) => !secrets[n]);
  out.push(missing.length === 0 ? { name: "secret names present", status: "PASS" } : { name: "secret names present", status: "MISSING", detail: missing.join(", "), fix: "README production setup steps 4 and 5, then npm run setup:prod" });
  return out;
}

async function cloudflareChecks(root: string, withDispatch: boolean): Promise<Check[]> {
  const out: Check[] = [];
  const wrangler = (args: string[]) => sh(join(root, "node_modules", ".bin", "wrangler"), args, root);
  const who = wrangler(["whoami"]);
  const loggedIn = who.ok && !/not authenticated|not logged in/i.test(who.out);
  out.push(loggedIn ? { name: "wrangler login", status: "PASS" } : { name: "wrangler login", status: "MISSING", fix: "npx wrangler login" });
  const statePath = join(root, ".prod", "state.json");
  if (!existsSync(statePath)) {
    out.push({ name: "production state", status: "MISSING", fix: "npm run setup:prod" });
    return out;
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as ProdState;
  const secrets = readEnvFile(join(root, ".prod", "secrets.env"));
  out.push(state.workers_subdomain ? { name: "workers.dev subdomain", status: "PASS", detail: state.workers_subdomain } : { name: "workers.dev subdomain", status: "MISSING", fix: "set PL_WORKERS_SUBDOMAIN and npm run setup:prod" });
  const rendered = join(root, "wrangler.production.jsonc");
  if (existsSync(rendered)) {
    const problems = freePlanConfigProblems(readFileSync(rendered, "utf8"));
    out.push(problems.length === 0 ? { name: "rendered production config needs nothing from Workers Paid", status: "PASS" } : { name: "rendered production config", status: "FAIL", detail: problems.join("; "), fix: "npm run deploy re-renders it from wrangler.jsonc" });
  }
  const buckets = wrangler(["r2", "bucket", "list"]).out;
  for (const b of [LAKE_BUCKET, REPORTS_BUCKET]) {
    out.push(buckets.includes(b) ? { name: `R2 bucket ${b}`, status: "PASS" } : { name: `R2 bucket ${b}`, status: "MISSING", fix: "enable R2 with a payment card (dash), then npm run setup:prod" });
  }
  const catalog = wrangler(["basin", "catalog", "get", LAKE_BUCKET]);
  out.push(catalog.ok && !/not enabled/i.test(catalog.out) ? { name: "Basin Catalog enabled", status: "PASS" } : { name: "Basin Catalog enabled", status: "MISSING", fix: "npm run setup:prod -- --only cloudflare" });
  const lakeCli = sh("uv", ["run", "--project", "pipeline", "peoplelake", "lake", "status", "--target", "prod"], root, {
    PL_R2_CATALOG_URI: state.catalog.uri,
    PL_R2_WAREHOUSE: state.catalog.warehouse,
    PL_R2_CATALOG_TOKEN: secrets["PL_R2_CATALOG_TOKEN"] ?? "",
  });
  const lakeStatus = (() => {
    try {
      return JSON.parse(lakeCli.out.split("\n").pop() ?? "{}") as { exists?: boolean; landing_cursor?: string | null };
    } catch {
      return {};
    }
  })();
  out.push(
    lakeStatus.exists
      ? { name: "Iceberg table peoplelake.raw_events", status: "PASS", detail: `landing cursor ${lakeStatus.landing_cursor ?? "none yet"}` }
      : { name: "Iceberg table peoplelake.raw_events", status: "MISSING", detail: lakeCli.out.slice(0, 200), fix: "npm run setup:prod -- --only cloudflare (peoplelake lake init --target prod)" },
  );
  const queues = wrangler(["queues", "list"]).out;
  for (const q of QUEUES) {
    out.push(queues.includes(q) ? { name: `queue ${q}`, status: "PASS" } : { name: `queue ${q}`, status: "MISSING", fix: "npm run setup:prod" });
  }
  const deployed = wrangler(["deployments", "list", "--name", "peoplelake"]);
  out.push(deployed.ok ? { name: "Worker peoplelake deployed", status: "PASS" } : { name: "Worker peoplelake deployed", status: "MISSING", fix: "npm run deploy" });
  const secretList = wrangler(["secret", "list", "--name", "peoplelake"]).out;
  for (const s of ["GCP_DISPATCHER_KEY"]) {
    out.push(secretList.includes(s) ? { name: `Worker secret ${s} (name only)`, status: "PASS" } : { name: `Worker secret ${s}`, status: "MISSING", fix: "npm run setup:prod -- --only worker" });
  }
  out.push(state.runs_enabled ? { name: "RUNS_ENABLED", status: "PASS" } : { name: "RUNS_ENABLED", status: "FAIL", detail: "false (fail-closed until GCP passes)", fix: "npm run setup:prod -- --only gcp, then --only worker" });

  const url = `https://peoplelake.${state.workers_subdomain}.workers.dev`;
  const anon = await fetch(`${url}/v1/health`, { redirect: "manual" }).catch(() => null);
  const answeredByAccess = anon !== null && (anon.status === 401 || anon.status === 403 || (anon.status >= 300 && anon.status < 400));
  out.push(answeredByAccess ? { name: "Access in front of the Worker", status: "PASS", detail: `unauthenticated /v1/health -> ${anon?.status}` } : { name: "Access in front of the Worker", status: "FAIL", detail: `unauthenticated /v1/health -> ${anon?.status ?? "no response"}`, fix: "npm run setup:prod -- --only cloudflare (Access application)" });
  const headers = (env: string) => ({ "CF-Access-Client-Id": secrets[`${env}_CLIENT_ID`] ?? "", "CF-Access-Client-Secret": secrets[`${env}_CLIENT_SECRET`] ?? "" });
  for (const [name, meta] of Object.entries(SERVICE_TOKENS)) {
    const res = await fetch(`${url}/v1/health/auth`, { headers: headers(meta.env) }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { roles?: string[] }) : null;
    out.push(body?.roles?.includes(meta.role) ? { name: `service token ${name} -> ${meta.role}`, status: "PASS" } : { name: `service token ${name} -> ${meta.role}`, status: "FAIL", detail: `HTTP ${res?.status ?? "none"}`, fix: "npm run setup:prod (tokens, Access policy, role map)" });
  }
  const wrong = await fetch(`${url}/v1/health/auth`, { headers: { "CF-Access-Client-Id": secrets["PL_CF_RUNNER_CLIENT_ID"] ?? "x", "CF-Access-Client-Secret": "wrong-secret" }, redirect: "manual" }).catch(() => null);
  out.push(wrong && [401, 403].includes(wrong.status) ? { name: "wrong service token secret rejected", status: "PASS" } : { name: "wrong service token secret rejected", status: "FAIL", detail: `HTTP ${wrong?.status ?? "none"}` });
  const op = headers("PL_CF_DOCTOR");
  const lake = await fetch(`${url}/api/ops/lake`, { headers: op }).catch(() => null);
  const lakeBody = lake?.ok ? ((await lake.json()) as { landing?: { landed_through?: string | null; pending_roll?: boolean } }) : null;
  out.push(
    lakeBody?.landing
      ? { name: "landing (LandingRoller)", status: "PASS", detail: `landed through ${lakeBody.landing.landed_through ?? "nothing yet"}` }
      : { name: "landing (LandingRoller)", status: "FAIL", detail: `HTTP ${lake?.status ?? "none"}`, fix: "npm run deploy" },
  );
  const budget = await fetch(`${url}/api/ops/budget`, { headers: op }).catch(() => null);
  if (budget?.ok) out.push(...opsBudgetChecks((await budget.json()) as OpsBudget));
  else out.push({ name: "GET /api/ops/budget", status: "FAIL", detail: `HTTP ${budget?.status ?? "none"}`, fix: "npm run deploy" });
  const ai = await fetch(`${url}/api/ops/ai`, { headers: op }).catch(() => null);
  const aiBody = ai?.ok ? ((await ai.json()) as { ok?: boolean; gateway_log_id_present?: boolean }) : null;
  out.push(aiBody?.gateway_log_id_present ? { name: "Workers AI through AI Gateway", status: "PASS" } : { name: "Workers AI through AI Gateway", status: "FAIL", detail: `HTTP ${ai?.status ?? "none"}`, fix: "npm run setup:prod (AI Gateway peoplelake)" });
  const dispatch = await fetch(`${url}/api/ops/dispatch${withDispatch ? "?execute=1" : ""}`, { headers: op }).catch(() => null);
  const dBody = dispatch?.ok ? ((await dispatch.json()) as { ok?: boolean }) : null;
  out.push(dBody?.ok ? { name: `Cloud Run dispatch token${withDispatch ? " and one execution" : ""}`, status: "PASS" } : { name: "Cloud Run dispatch token", status: "FAIL", detail: `HTTP ${dispatch?.status ?? "none"}`, fix: "check GCP_DISPATCHER_KEY (npm run setup:prod -- --only worker)" });
  return out;
}

async function main(): Promise<number> {
  const root = process.cwd();
  const localOnly = process.argv.includes("--local-only");
  const quick = process.argv.includes("--quick");
  const checks = [...(await localChecks(root))];
  if (!localOnly) {
    checks.push(...prodFileChecks(root));
    checks.push(...(await cloudflareChecks(root, process.argv.includes("--with-dispatch"))));
  }
  for (const c of checks) console.log(format(c));
  let failed = checks.some((c) => c.status === "FAIL" || c.status === "MISSING");
  if (!localOnly && !quick) {
    console.log("\nGoogle Cloud (peoplelake prod doctor-gcp)");
    const gcp = spawnSync("uv", ["run", "--project", "pipeline", "peoplelake", "prod", "doctor-gcp"], { cwd: root, stdio: "inherit" });
    failed = failed || gcp.status !== 0;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
