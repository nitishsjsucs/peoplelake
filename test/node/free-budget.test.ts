import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBudget, replaceBudgetSection } from "../../scripts/budget.ts";
import { budgetInputsFromConfig, freePlanConfigProblems } from "../../scripts/lib/free-plan.ts";
import { MAX_BATCH_EVENTS } from "../../src/shared/contracts.ts";
import {
  AI_DAILY_NEURON_CAP,
  type BudgetInputs,
  budgetRows,
  cronRunsPerDay,
  overBudget,
  PRODUCTION_GUARDS,
} from "../../src/shared/free-budget.ts";
import { findProseViolations } from "../../scripts/lib/prose.ts";

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const inputs = budgetInputsFromConfig(wrangler);
const byId = (i: BudgetInputs) => Object.fromEntries(budgetRows(i).map((r) => [r.id, r]));

describe("Workers Free plan budget (SPEC 29.5, 15.7)", () => {
  it("reads the repo's constants and the production config", () => {
    expect(inputs).toMatchObject({
      maxBatchEvents: MAX_BATCH_EVENTS,
      sourceTickSeconds: 10,
      sources: 3,
      deliveryMinutes: 60,
      landingRollSeconds: 60,
      queueMaxRetries: 3,
      cronExpressions: ["*/5 * * * *"],
      runMinIntervalSeconds: PRODUCTION_GUARDS.RUN_MIN_INTERVAL_SECONDS,
      autoRunsMaxPerDay: PRODUCTION_GUARDS.AUTO_RUNS_MAX_PER_DAY,
      aiDailyNeuronCap: AI_DAILY_NEURON_CAP,
      bqMonthlyBytesCap: PRODUCTION_GUARDS.BQ_MONTHLY_BYTES_CAP,
    });
    expect(cronRunsPerDay("*/5 * * * *")).toBe(288);
    expect(cronRunsPerDay("* * * * *")).toBe(1440);
  });

  it("keeps every peak-day estimate within its planning share", () => {
    const rows = byId(inputs);
    expect(overBudget(budgetRows(inputs))).toEqual([]);
    // The SPEC's arithmetic: 100,000 / 50 + 360 ticks x 3 sources.
    expect(rows["workerRequests"]?.basis).toContain("ingest 3080");
    expect(rows["queueOperations"]?.estimate).toBeLessThanOrEqual(2_000);
    expect(rows["doRowsWritten"]?.estimate).toBeLessThanOrEqual(20_000);
    expect(rows["workflowSteps"]?.estimate).toBeLessThanOrEqual(600);
    expect(rows["workersAiNeurons"]?.estimate).toBeLessThanOrEqual(2_000);
    expect(rows["bigqueryQueries"]?.estimate).toBeLessThanOrEqual(275_000_000_000);
    expect(rows["cronTriggers"]?.estimate).toBe(1);
  });

  it.each([
    ["raising the batch size to 500", { maxBatchEvents: 500 }, "ingestBatchEvents"],
    ["adding a cron", { cronExpressions: ["*/5 * * * *", "0 * * * *"] }, "cronTriggers"],
    ["shortening the run interval to 30 s", { runMinIntervalSeconds: 30, autoRunsMaxPerDay: 200 }, "workflowSteps"],
    ["raising the AI cap to 3,000 neurons", { aiDailyNeuronCap: 3_000 }, "workersAiNeurons"],
    ["raising the BigQuery guard to 400 GB", { bqMonthlyBytesCap: 400_000_000_000 }, "bigqueryQueries"],
    ["posting every second in production", { sourceTickSeconds: 1 }, "doRowsWritten"],
  ] as const)("fails when %s", (_name, change, row) => {
    expect(overBudget(budgetRows({ ...inputs, ...change })).map((r) => r.id)).toContain(row);
  });

  it("refuses configs that need Workers Paid or break the budget's production values", () => {
    expect(freePlanConfigProblems(wrangler)).toEqual([]);
    const perMinute = wrangler.replaceAll('"crons": ["*/5 * * * *"]', '"crons": ["* * * * *"]');
    expect(freePlanConfigProblems(perMinute).join(" ")).toContain("exactly one cron");
    const pipelines = wrangler.replace('"name": "peoplelake-local",', '"name": "peoplelake-local", "pipelines": [{ "binding": "RAW_STREAM", "stream": "x" }],');
    expect(freePlanConfigProblems(pipelines).join(" ")).toContain("Workers Paid");
    const limits = wrangler.replace('"name": "peoplelake-local",', '"name": "peoplelake-local", "limits": { "cpu_ms": 50 },');
    expect(freePlanConfigProblems(limits).join(" ")).toContain("limits");
    const kv = wrangler.replace('"new_sqlite_classes": ["Coordinator", "LandingRoller"]', '"new_classes": ["Coordinator", "LandingRoller"]');
    expect(freePlanConfigProblems(kv).join(" ")).toContain("SQLite");
    const paidModel = wrangler.replace('"AI_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"', '"AI_MODEL": "@cf/moonshotai/kimi-k2.6"');
    expect(freePlanConfigProblems(paidModel).join(" ")).toContain("paid billing");
    const fastRuns = wrangler.replace('"RUN_MIN_INTERVAL_SECONDS": "240"', '"RUN_MIN_INTERVAL_SECONDS": "60"');
    expect(freePlanConfigProblems(fastRuns).join(" ")).toContain("RUN_MIN_INTERVAL_SECONDS must be 240");
  });

  it("renders the README table without dashes in prose and replaces only the marked section", () => {
    const text = renderBudget(budgetRows(inputs), null, []);
    expect(text).toContain("| Worker requests | 100,000 requests (a day, account) | 20,000 |");
    expect(findProseViolations(text)).toEqual([]);
    const readme = "a\n<!-- budget:start -->\nold\n<!-- budget:end -->\nb";
    expect(replaceBudgetSection(readme, "new")).toBe("a\n<!-- budget:start -->\nnew\n<!-- budget:end -->\nb");
    expect(replaceBudgetSection("no markers", "x")).toBeNull();
  });
});
