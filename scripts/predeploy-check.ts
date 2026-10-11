// Refuses a production deploy that is unsafe (SPEC 7.1). Usage: node scripts/predeploy-check.ts [--config path] [--state path]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProdState } from "./lib/prod-state.ts";
import { parseJsonc } from "./render-wrangler.ts";

interface WranglerConfig {
  name?: string;
  workers_dev?: boolean;
  env?: { production?: { name?: string; preview_urls?: boolean; vars?: Record<string, string> } };
}

export function predeployProblems(configText: string, state: Pick<ProdState, "gcp_bootstrap_passed">): string[] {
  const problems: string[] = [];
  if (configText.includes("__PL_")) problems.push("unrendered __PL_ placeholders remain");
  const config = parseJsonc<WranglerConfig>(configText, "wrangler config");
  const prod = config.env?.production;
  if (!prod) return [...problems, "no env.production section"];
  const vars = prod.vars ?? {};
  if (config.name === prod.name) problems.push("the top-level Worker name must differ from the production name");
  if (config.workers_dev !== false) problems.push("the top-level (local) config must set workers_dev: false");
  if (prod.preview_urls !== false) problems.push("production must set preview_urls: false");
  const expect: Record<string, string> = {
    ENVIRONMENT: "production",
    AUTH_MODE: "access",
    LAKE_MODE: "basin",
    RUNNER_DISPATCH: "cloudrun",
    EVAL_FAULTS_ENABLED: "false",
  };
  for (const [k, v] of Object.entries(expect)) {
    if (vars[k] !== v) problems.push(`production ${k} must be ${v} (is ${vars[k] ?? "unset"})`);
  }
  const runs = vars["RUNS_ENABLED"];
  if (runs !== "true" && runs !== "false") problems.push("production RUNS_ENABLED must be true or false");
  if (runs === "true" && !state.gcp_bootstrap_passed) problems.push("RUNS_ENABLED=true needs a passing `peoplelake prod bootstrap-gcp`");
  if (vars["ACCESS_AUD"] === "pending" && runs !== "false") problems.push("ACCESS_AUD=pending is allowed only with RUNS_ENABLED=false");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars["ACCESS_TEAM_DOMAIN"] ?? "")) {
    problems.push("ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com");
  }
  return problems;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const configText = readFileSync(arg("--config") ?? join(root, "wrangler.production.jsonc"), "utf8");
  const state = JSON.parse(readFileSync(arg("--state") ?? join(root, ".prod", "state.json"), "utf8")) as ProdState;
  const problems = predeployProblems(configText, state);
  if (problems.length > 0) {
    for (const p of problems) console.error(`predeploy-check: ${p}`);
    process.exit(1);
  }
  console.log("predeploy-check: production config is safe to deploy");
}
