import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freePlanConfigProblems } from "../../scripts/lib/free-plan.ts";
import { PLACEHOLDERS, type ProdState } from "../../scripts/lib/prod-state.ts";
import { CRON_EXPRESSION, PRODUCTION_GUARDS } from "../../src/shared/free-budget.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { predeployProblems } from "../../scripts/predeploy-check.ts";
import { parseJsonc, renderWrangler } from "../../scripts/render-wrangler.ts";

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const state = JSON.parse(readFileSync("scripts/fixtures/prod-state.example.json", "utf8")) as ProdState;

type Config = {
  name: string;
  workers_dev: boolean;
  env: { production: { name: string; workers_dev: boolean; vars: Record<string, string>; pipelines?: unknown; r2_buckets: { binding: string; bucket_name: string }[] } };
};

describe("Workers Free plan configuration", () => {
  type Env = { vars: Record<string, string>; triggers?: { crons: string[] } };
  const config = parseJsonc<Env & { env: { production: Env } }>(wrangler, "wrangler.jsonc");

  it("declares exactly one cron, every 5 minutes, in every environment", () => {
    expect(CRON_EXPRESSION).toBe("*/5 * * * *");
    expect(config.triggers?.crons).toEqual([CRON_EXPRESSION]);
    expect(config.env.production.triggers?.crons).toEqual([CRON_EXPRESSION]);
  });

  it("needs nothing from Workers Paid in either environment, rendered or not", () => {
    expect(freePlanConfigProblems(wrangler)).toEqual([]);
    const rendered = renderWrangler(wrangler, state);
    expect(freePlanConfigProblems(rendered)).toEqual([]);
    const paid = rendered.replace('"name": "peoplelake-local",', '"name": "peoplelake-local",\n  "limits": { "cpu_ms": 50 },');
    expect(predeployProblems(paid, state).join(" ")).toContain("limits (cpu_ms) is a Workers Paid setting");
  });

  it("refuses a working tree whose peak-day estimate passes a planning share, before CI could", () => {
    const rendered = renderWrangler(wrangler, state);
    const at = rendered.indexOf('"production"');
    const fastRolls = rendered.slice(0, at) + rendered.slice(at).replace('"LANDING_ROLL_SECONDS": "60"', '"LANDING_ROLL_SECONDS": "5"');
    const problems = predeployProblems(fastRolls, state).join(" ");
    expect(problems).toContain("LANDING_ROLL_SECONDS must be at least 60");
    expect(problems).toContain("Queue operations: peak estimate 8664 passes the planning share 2000");
  });

  it("sets the production run guards to the Free plan values (heartbeat off)", () => {
    const prod = config.env.production.vars;
    for (const [name, value] of Object.entries(PRODUCTION_GUARDS)) expect(prod[name], name).toBe(String(value));
  });
});

describe("production config", () => {
  it("names the local Worker differently from production and keeps it off workers.dev", () => {
    const config = parseJsonc<Config>(wrangler, "wrangler.jsonc");
    expect(config.name).toBe("peoplelake-local");
    expect(config.env.production.name).toBe("peoplelake");
    expect(config.workers_dev).toBe(false);
    for (const p of PLACEHOLDERS) expect(wrangler).toContain(p);
  });

  it("renders every placeholder, including the role map as a JSON string", () => {
    const rendered = renderWrangler(wrangler, state);
    expect(rendered).not.toContain("__PL_");
    const prod = parseJsonc<Config>(rendered, "rendered").env.production;
    expect(prod.vars["ACCESS_AUD"]).toBe(state.access.aud);
    expect(JSON.parse(prod.vars["ACCESS_ROLE_MAP"] ?? "")).toEqual(state.role_map);
    expect(prod.vars["RUNS_ENABLED"]).toBe("true");
    expect(prod.vars["EVAL_FAULTS_ENABLED"]).toBe("false");
    expect(prod.pipelines).toBeUndefined();
    expect(prod.r2_buckets).toContainEqual({ binding: "LAKE_BUCKET", bucket_name: "peoplelake-lake" });
    expect(predeployProblems(rendered, state)).toEqual([]);
  });

  it("refuses unsafe configurations", () => {
    expect(predeployProblems(wrangler, state)).toContain("unrendered __PL_ placeholders remain");
    const rendered = renderWrangler(wrangler, state);
    expect(predeployProblems(rendered, { gcp_bootstrap_passed: false })).toContain(
      "RUNS_ENABLED=true needs a passing `peoplelake prod bootstrap-gcp`",
    );
    const pending = renderWrangler(wrangler, { ...state, access: { ...state.access, aud: "pending" } });
    expect(predeployProblems(pending, state)).toContain("ACCESS_AUD=pending is allowed only with RUNS_ENABLED=false");
    const firstDeploy = renderWrangler(wrangler, { ...state, runs_enabled: false, access: { ...state.access, aud: "pending" } });
    expect(predeployProblems(firstDeploy, { gcp_bootstrap_passed: false })).toEqual([]);
    const faults = rendered.replace('"EVAL_FAULTS_ENABLED": "false"', '"EVAL_FAULTS_ENABLED": "true"');
    expect(predeployProblems(faults, state)).toContain("production EVAL_FAULTS_ENABLED must be false (is true)");
    const sameName = rendered.replace('"name": "peoplelake-local"', '"name": "peoplelake"');
    expect(predeployProblems(sameName, state)).toContain("the top-level Worker name must differ from the production name");
  });

  it("declares every top-level var in production, since wrangler does not inherit vars (LLM_BASE_URL empty: production uses workers-ai)", () => {
    type Vars = { vars: Record<string, string>; env: { production: { vars: Record<string, string> } } };
    const config = parseJsonc<Vars>(wrangler, "wrangler.jsonc");
    const prod = config.env.production.vars;
    expect(Object.keys(config.vars).filter((k) => !(k in prod))).toEqual([]);
    expect(prod["AI_PROVIDER"]).toBe("workers-ai");
    expect(prod["LLM_BASE_URL"]).toBe("");
    // The empty value parses as no base URL, exactly as an unset one did.
    const rendered = parseJsonc<Vars>(renderWrangler(wrangler, state), "rendered").env.production.vars;
    const ai = parseConfig({ ...rendered, GCP_DISPATCHER_KEY: "{}" }, null).ai;
    expect([ai.provider, ai.llmBaseUrl]).toEqual(["workers-ai", null]);
    // predeploy-check refuses a top-level var that production leaves out (the dry run's wrangler warning).
    const dropped = renderWrangler(wrangler, state).replace(/\n\s*"LLM_BASE_URL": "",?/, "");
    expect(predeployProblems(dropped, state)).toContain(
      "vars.LLM_BASE_URL is set at the top level but not in env.production.vars (vars are not inherited; set it there explicitly)",
    );
  });

  it("serves the dashboard as assets with the API routes running the Worker first, and refuses an unbuilt dashboard", () => {
    const config = parseJsonc<{ assets: { directory: string; not_found_handling: string; run_worker_first: string[] } }>(wrangler, "wrangler.jsonc");
    expect(config.assets.directory).toBe("./web/dist");
    expect(config.assets.not_found_handling).toBe("single-page-application");
    expect(config.assets.run_worker_first).toEqual(["/v1/*", "/api/*", "/internal/*", "/dev/*"]);
    const rendered = renderWrangler(wrangler, state);
    expect(predeployProblems(rendered, state, { assetsIndexExists: true })).toEqual([]);
    expect(predeployProblems(rendered, state, { assetsIndexExists: false })).toContain(
      "the dashboard is not built (web/dist/index.html is missing): npm run build:web",
    );
    const apiToAssets = rendered.replace('"/api/*",', "");
    expect(predeployProblems(apiToAssets, state)).toContain("assets.run_worker_first must route /api/* to the Worker");
  });
});
