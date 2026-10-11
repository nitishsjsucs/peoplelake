// npm run budget [-- --check | --json | --readme]
//
// The Workers Free plan budget (SPEC 29.5, 15.7) computed from this repo's constants and its production
// configuration (wrangler.jsonc env.production): every peak-day estimate against its Free allowance and the
// planning share this repo allows itself (20% of each account-wide Cloudflare allowance, 25% of each Google
// free tier), the per-request CPU measured by `npm run bench:ingest`, and the config rules (no pipelines,
// no limits, one cron, SQLite Durable Objects, the production guard values). `--check` exits 1 when an
// estimate passes its share or a rule is broken (and when the README budget section is stale); `--readme`
// renders the table into README.md between the budget markers.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BudgetRow, budgetRows, FREE_CPU_MS, overBudget } from "../src/shared/free-budget.ts";
import { budgetInputsFromConfig, freePlanConfigProblems } from "./lib/free-plan.ts";

export const BUDGET_START = "<!-- budget:start -->";
export const BUDGET_END = "<!-- budget:end -->";

export interface CpuEvidence {
  file: string;
  date: string;
  batchLimit: number;
  warmP99Ms: number;
  firstAfterPrewarmMs: number;
}

/** The newest `npm run bench:ingest` result at the batch limit, if one is committed. */
export function latestCpuEvidence(root: string): CpuEvidence | null {
  const dir = join(root, "evals", "results");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^ingest-cpu-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  } catch {
    return null;
  }
  const name = names[names.length - 1];
  if (!name) return null;
  const report = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    date: string;
    batch_limit: number;
    sizes: { events: number; warm_p99_ms: [number, number]; first_request_after_prewarm_ms: [number, number] }[];
  };
  const at = report.sizes.find((s) => s.events === report.batch_limit);
  if (!at) return null;
  return { file: `evals/results/${name}`, date: report.date, batchLimit: report.batch_limit, warmP99Ms: at.warm_p99_ms[1], firstAfterPrewarmMs: at.first_request_after_prewarm_ms[1] };
}

function fmt(n: number, unit: string): string {
  if (unit === "bytes") {
    const TiB = 1_099_511_627_776;
    const GiB = 1_073_741_824;
    if (n % TiB === 0) return `${n / TiB} TiB`;
    if (n % GiB === 0) return `${n / GiB} GiB`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
    return `${Math.round(n / 1e6)} MB`;
  }
  return n.toLocaleString("en-US");
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

export function renderBudget(rows: readonly BudgetRow[], cpu: CpuEvidence | null, problems: readonly string[]): string {
  const lines = [
    "Computed by `npm run budget` from the repo's constants and `wrangler.jsonc` `env.production` (estimates, not measurements; the CPU row is a Node measurement standing in for workerd). Rows marked \"reported, not gated\" pass this repo's planning share by the SPEC's own estimate and cost cents a month beyond the free tier; `--check` fails on every other row. The go-live day is the peak: one 60-minute delivery of 100,000 events from three sources posting every 10 s, the runs it triggers, the cron, the doctor and the 60-question Workers AI eval. Planning share: 20% of each account-wide Cloudflare allowance, 25% of each Google free tier.",
    "",
    "| Path | Free allowance | Planning share | Peak estimate | Share of the allowance | Within share | Basis |",
    "|---|---|---:|---:|---:|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${fmt(r.allowance, r.unit)} ${r.unit === "bytes" ? "" : `${r.unit} `}(${r.scope}) | ${fmt(r.limit, r.unit)} | ${fmt(r.estimate, r.unit)} | ${pct(r.estimate / r.allowance)} | ${r.estimate <= r.limit ? "yes" : r.gated ? "NO" : "no (reported, not gated)"} | ${r.basis} |`,
    );
  }
  if (cpu) {
    const ok = cpu.warmP99Ms < FREE_CPU_MS && cpu.firstAfterPrewarmMs < FREE_CPU_MS;
    lines.push(
      `| CPU per ingest request (${cpu.batchLimit} events) | ${FREE_CPU_MS} ms per request | ${FREE_CPU_MS} ms | warm p99 ${cpu.warmP99Ms} ms, first after prewarm ${cpu.firstAfterPrewarmMs} ms | ${pct(Math.max(cpu.warmP99Ms, cpu.firstAfterPrewarmMs) / FREE_CPU_MS)} | ${ok ? "yes" : "NO"} | measured in Node as a proxy for workerd (not yet on Cloudflare): \`${cpu.file}\` (${cpu.date}), the worst of the three sources |`,
    );
  }
  lines.push("", problems.length === 0 ? "Configuration rules (no `pipelines`, no `limits`, one `*/5 * * * *` cron, SQLite Durable Objects only, the production guard values, a Free plan model): all hold." : `Configuration rules broken: ${problems.join("; ")}.`);
  return lines.join("\n");
}

export function replaceBudgetSection(readme: string, body: string): string | null {
  const start = readme.indexOf(BUDGET_START);
  const end = readme.indexOf(BUDGET_END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${readme.slice(0, start + BUDGET_START.length)}\n${body}\n${readme.slice(end)}`;
}

function main(): number {
  const root = process.cwd();
  const configText = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const rows = budgetRows(budgetInputsFromConfig(configText));
  const cpu = latestCpuEvidence(root);
  const problems = freePlanConfigProblems(configText);
  const over = overBudget(rows);
  const cpuOver = cpu !== null && (cpu.warmP99Ms >= FREE_CPU_MS || cpu.firstAfterPrewarmMs >= FREE_CPU_MS);
  const body = renderBudget(rows, cpu, problems);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ rows, cpu, problems, over: over.map((r) => r.id) }, null, 2));
    return 0;
  }
  const readmePath = join(root, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const next = replaceBudgetSection(readme, body);
  if (process.argv.includes("--readme")) {
    if (next === null) {
      console.error("README.md has no budget markers");
      return 1;
    }
    writeFileSync(readmePath, next);
    console.log("README Free plan budget section rendered");
    return 0;
  }
  console.log(body);
  if (process.argv.includes("--check")) {
    const failures = [
      ...over.map((r) => `${r.label}: estimate ${r.estimate} passes the planning share ${r.limit}`),
      ...(cpuOver ? ["CPU per ingest request reaches the 10 ms Free limit"] : []),
      ...problems,
      ...(next !== null && next !== readme ? ["README Free plan budget section is stale: run `npm run budget -- --readme`"] : []),
    ];
    for (const f of failures) console.error(`budget: ${f}`);
    if (failures.length > 0) return 1;
    const reported = rows.filter((r) => !r.gated && r.estimate > r.limit).map((r) => r.label);
    console.log(`\nbudget: every gated estimate is within its planning share${reported.length ? `; reported past the share: ${reported.join(", ")}` : ""}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
