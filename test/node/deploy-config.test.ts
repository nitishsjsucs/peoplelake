import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLACEHOLDERS, type ProdState } from "../../scripts/lib/prod-state.ts";
import { predeployProblems } from "../../scripts/predeploy-check.ts";
import { parseJsonc, renderWrangler } from "../../scripts/render-wrangler.ts";

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const state = JSON.parse(readFileSync("scripts/fixtures/prod-state.example.json", "utf8")) as ProdState;

type Config = {
  name: string;
  workers_dev: boolean;
  env: { production: { name: string; workers_dev: boolean; vars: Record<string, string>; pipelines: { stream: string }[] } };
};

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
    expect(prod.pipelines[0]?.stream).toBe(state.stream_id);
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
