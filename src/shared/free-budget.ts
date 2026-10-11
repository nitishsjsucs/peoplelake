// Workers Free plan budget (SPEC 29): the production guard values, the bounds parseConfig enforces in
// production, and the constants the usage estimates use. Shared by the Worker, the scripts and the tests,
// so a change that would pass a Free allowance fails a test instead of reaching production.

/** Production values of the run guards (SPEC 29.6); wrangler.jsonc env.production must equal these. */
export const PRODUCTION_GUARDS = {
  RUN_MIN_INTERVAL_SECONDS: 240,
  FAILURE_BACKOFF_BASE_MINUTES: 5,
  FAILURE_BACKOFF_MAX_MINUTES: 360,
  AUTO_RUNS_MAX_PER_DAY: 30,
  // At most 25% of the 1 TiB free tier (274,877,906,944 bytes), rounded down.
  BQ_MONTHLY_BYTES_CAP: 274_000_000_000,
  HEARTBEAT_MINUTES: 0,
} as const;

/** parseConfig refuses production values outside these bounds (SPEC 29.6). */
export const GUARD_BOUNDS = {
  runMinIntervalSecondsAtLeast: 240,
  failureBackoffBaseMinutesAtLeast: 5,
  autoRunsMaxPerDayAtMost: 30,
  bqMonthlyBytesCapAtMost: 274_000_000_000,
  heartbeatMinutesAtMost: 0,
  // What the peak-day estimates assume (a smaller roll interval or more retries multiply Queue operations
  // and Workflow steps); parseConfig and predeploy-check refuse values outside them.
  landingRollSecondsAtLeast: 60,
  queueMaxRetriesAtMost: 3,
  jobMaxAttemptsAtMost: 3,
  runTimeoutMinutesAtMost: 45,
} as const;

/** Bytes a transform run is assumed to bill (SPEC 29.5: about 3 GB, mostly the 10 MB minimum per table). */
export const BQ_TRANSFORM_RESERVE_BYTES = 3_000_000_000;

/** The only cron expression (1 of the account's 5 Cron Triggers): sweeps and the backstop. */
export const CRON_EXPRESSION = "*/5 * * * *";

/** Durable Object SQL usage counters are written to storage at most this often. */
export const USAGE_FLUSH_MS = 5 * 60_000;

/** Minutes automatic triggers wait after `failures` consecutive failed runs: min(base * 2^(k-1), max). */
export function backoffMinutes(failures: number, baseMinutes: number, maxMinutes: number): number {
  if (failures <= 0 || baseMinutes <= 0) return 0;
  return Math.min(baseMinutes * 2 ** (failures - 1), maxMinutes);
}

// -- Workers AI (SPEC 29.4.5) -----------------------------------------------------------------------

/** The production model: JSON mode, active per the 2026-05-08 deprecation notice, not paid-billing only. */
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Neurons per million tokens (Workers AI pricing, 2026-10-10). Unknown models are charged at the 70B price,
 * the highest listed, so a reservation never undercounts. */
export const AI_NEURONS_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26_668, output: 204_805 },
  "@cf/meta/llama-3.1-8b-instruct-fp8": { input: 13_778, output: 26_128 },
};

export const AI_MAX_TOKENS = 96;
export const AI_DAILY_NEURON_CAP = 1_800;
/** parseConfig refuses a production cap above this (20% of the account's 10,000 neurons a day). */
export const AI_DAILY_NEURON_CAP_AT_MOST = 2_000;
/** Characters per token used to size a call's input (conservative for English prompts). */
export const AI_CHARS_PER_TOKEN = 3;
/** Tokens the chat template adds around the messages. */
export const AI_TEMPLATE_TOKENS = 60;

export function aiNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const price = AI_NEURONS_PER_MILLION_TOKENS[model] ?? AI_NEURONS_PER_MILLION_TOKENS[AI_MODEL] ?? { input: 26_668, output: 204_805 };
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Neurons reserved before a call: the input sized from its characters, the output at max_tokens, rounded up. */
export function aiReservation(model: string, inputChars: number, maxTokens: number): number {
  const inputTokens = Math.ceil(inputChars / AI_CHARS_PER_TOKEN) + AI_TEMPLATE_TOKENS;
  return Math.ceil(aiNeurons(model, inputTokens, maxTokens));
}

// -- Models that need a paid billing method or are deprecated (SPEC 29.2) ----------------------------

/** Workers AI models that return 403 on the Free plan (they need a paid billing method, 2026-07-28). */
export const AI_PAID_BILLING_MODELS = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
] as const;

/** Model ids deprecated on 2026-05-30 that this repo must not use (a sample of the 18; the 8B fast id 404s). */
export const AI_DEPRECATED_MODELS = ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"] as const;

// -- Free allowances and planning shares (SPEC 29.2, 29.5) --------------------------------------------

/** Share of each account-wide Cloudflare allowance this repo plans to use (five sibling Workers share the
 * account), and of each Google free tier (four repos share the project). */
export const CLOUDFLARE_PLANNING_SHARE = 0.2;
export const GOOGLE_PLANNING_SHARE = 0.25;

const CF = "https://developers.cloudflare.com";

export interface Allowance {
  label: string;
  value: number;
  unit: string;
  scope: string;
  share: number;
  source: string;
}

export const ALLOWANCES = {
  workerRequests: { label: "Worker requests", value: 100_000, unit: "requests", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/workers/platform/limits/` },
  workflowSteps: { label: "Workflow steps", value: 3_000, unit: "steps", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/workflows/reference/pricing/` },
  queueOperations: { label: "Queue operations", value: 10_000, unit: "operations", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/queues/platform/pricing/` },
  doRequests: { label: "Durable Object requests", value: 100_000, unit: "requests", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/durable-objects/platform/pricing/` },
  doRowsWritten: { label: "Durable Object rows written", value: 100_000, unit: "rows", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/durable-objects/platform/pricing/` },
  doRowsRead: { label: "Durable Object rows read", value: 5_000_000, unit: "rows", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/durable-objects/platform/pricing/` },
  doDuration: { label: "Durable Object duration", value: 13_000, unit: "GB-s", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/durable-objects/platform/pricing/` },
  workersAiNeurons: { label: "Workers AI neurons", value: 10_000, unit: "neurons", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/workers-ai/platform/pricing/` },
  workersLogs: { label: "Workers Logs events", value: 200_000, unit: "events", scope: "a day, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/workers/observability/logs/workers-logs/` },
  cronTriggers: { label: "Cron Triggers", value: 5, unit: "triggers", scope: "account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/workers/platform/limits/` },
  aiGateways: { label: "AI Gateway gateways", value: 10, unit: "gateways", scope: "account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/ai-gateway/reference/limits/` },
  accessSeats: { label: "Zero Trust seats", value: 50, unit: "users", scope: "account", share: CLOUDFLARE_PLANNING_SHARE, source: "https://www.cloudflare.com/zero-trust/products/access/" },
  serviceTokens: { label: "Access service tokens", value: 50, unit: "tokens", scope: "account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/cloudflare-one/account-limits/` },
  envVars: { label: "Environment variables", value: 64, unit: "variables", scope: "per Worker", share: 1, source: `${CF}/workers/platform/limits/` },
  r2Storage: { label: "R2 storage", value: 10_000_000_000, unit: "bytes", scope: "GB-month, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/r2/pricing/` },
  r2ClassA: { label: "R2 Class A operations", value: 1_000_000, unit: "operations", scope: "a month, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/r2/pricing/` },
  r2ClassB: { label: "R2 Class B operations", value: 10_000_000, unit: "operations", scope: "a month, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/r2/pricing/` },
  catalogOperations: { label: "Basin Catalog operations", value: 1_000_000, unit: "operations", scope: "a month, account", share: CLOUDFLARE_PLANNING_SHARE, source: `${CF}/basin-catalog/platform/pricing/` },
  // Not an allowance but the largest batch whose measured CPU leaves room under 10 ms (SPEC 29.4.2: 100 events
  // reached 4.6 to 7.1 ms on a first request after the prewarm and 200 events 6.9 to 12.4 ms).
  ingestBatchEvents: { label: "Events per ingest request", value: 50, unit: "events", scope: "per request, set by the 10 ms CPU limit", share: 1, source: `${CF}/workers/platform/limits/` },
  bigqueryQueries: { label: "BigQuery queries", value: 1_099_511_627_776, unit: "bytes", scope: "a month, billing account", share: GOOGLE_PLANNING_SHARE, source: "https://cloud.google.com/bigquery/pricing" },
  bigqueryStorage: { label: "BigQuery storage", value: 10_737_418_240, unit: "bytes", scope: "a month, billing account", share: GOOGLE_PLANNING_SHARE, source: "https://cloud.google.com/bigquery/pricing" },
  cloudBuildMinutes: { label: "Cloud Build minutes", value: 2_500, unit: "build-minutes", scope: "a month, billing account", share: GOOGLE_PLANNING_SHARE, source: "https://cloud.google.com/build/pricing" },
  artifactRegistryStorage: { label: "Artifact Registry storage", value: 500_000_000, unit: "bytes", scope: "a month, billing account", share: GOOGLE_PLANNING_SHARE, source: "https://cloud.google.com/artifact-registry/pricing" },
  secretVersions: { label: "Secret Manager active versions", value: 6, unit: "versions", scope: "a month, billing account", share: GOOGLE_PLANNING_SHARE, source: "https://cloud.google.com/secret-manager/pricing" },
} as const satisfies Record<string, Allowance>;

/** Per-invocation limits on the Workers Free plan (not shared): CPU per request or step, subrequests. */
export const FREE_CPU_MS = 10;
export const FREE_EXTERNAL_SUBREQUESTS = 50;
/** The metrics artifact PUT's size limit: about twice the full-profile snapshot (124 KB, 468 rows), since
 * the PUT and the Workflow's verify step hash it within 10 ms of CPU (npm run bench:ingest times it). */
export const MAX_ARTIFACT_BYTES = 256 * 1024;

// -- Peak-day estimators (SPEC 29.5) ------------------------------------------------------------------

/** What the estimates are computed from: the repo's constants and its production configuration. */
export interface BudgetInputs {
  maxBatchEvents: number;
  deliveryEvents: number;
  deliveryMinutes: number;
  sourceTickSeconds: number;
  sources: number;
  landingRollSeconds: number;
  queueMaxRetries: number;
  cronExpressions: readonly string[];
  runMinIntervalSeconds: number;
  autoRunsMaxPerDay: number;
  aiDailyNeuronCap: number;
  bqMonthlyBytesCap: number;
  /** Variables plus secrets of the production Worker. */
  envVars: number;
  /** Access identities that sign in (the owner and the persona addresses). */
  humanSeats: number;
  serviceTokens: number;
  drillScenarios: number;
  drillChunks: number;
}

/** Fixed facts about the code that the estimators use (counted in warehouse-run.ts and the runner). */
export const PEAK_DAY = {
  extraRuns: 5, // operator runs, the backstop and the quiescence run on the go-live day
  stepsPerCommittedRun: 8,
  stepsWorstRun: 25,
  runnerCallsPerRun: 20, // claim, heartbeats, results, artifact, roll listing and reads
  workflowDoCallsPerRun: 24,
  operatorRequests: 300, // operator, dashboard, doctor and eval calls
  coordinatorRowsPerRun: 100, // rows written by one committed run, setAlarm calls included (measured 66 in coordinator.test.ts)
  indexOverhead: 1.3,
  ndjsonBytesPerRecord: 632, // measured on the full profile (SPEC 25, revision 3)
  icebergAndReportBytes: 22_000_000,
  activeObjectMinutesExtra: 10,
  objectMemoryGb: 0.128,
  secondsBilledPerCronActivation: 10,
  bqBytesPerTransform: BQ_TRANSFORM_RESERVE_BYTES,
  goLiveOtherTransforms: 2, // restore drill, masking demo, verify and doctor, rounded up
  buildsPerMonth: 3,
  minutesPerBuild: 8,
  bqStorageBytes: 500_000_000,
  // Measured 2026-10-11: the gzip of `docker save` of the runner image (linux/arm64 on the build Mac; Cloud
  // Build makes linux/amd64), after the Dockerfile stopped baking uv's cache in; the cleanup policy keeps 1.
  // CI's runner-image job prints the same measurement for linux/amd64 on every push.
  runnerImageBytes: 340_000_000,
  runnerImagesKept: 1,
  // One active version per secret: bootstrap destroys superseded versions (peoplelake-r2-catalog-token,
  // peoplelake-runner-client-id, peoplelake-runner-client-secret).
  secretActiveVersions: 3,
} as const;

// Runs of one cron expression per day (minute and hour fields: a star, a step such as "every 5", or a list).
export function cronRunsPerDay(expression: string): number {
  const [minute = "*", hour = "*"] = expression.trim().split(/\s+/);
  const per = (field: string, range: number): number => {
    if (field === "*") return range;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Math.ceil(range / Number(step[1]));
    return field.split(",").length;
  };
  return per(minute, 60) * per(hour, 24);
}

export interface BudgetRow {
  id: keyof typeof ALLOWANCES;
  label: string;
  estimate: number;
  limit: number;
  allowance: number;
  unit: string;
  scope: string;
  share: number;
  basis: string;
  gated: boolean;
}

export function budgetRows(i: BudgetInputs): BudgetRow[] {
  const P = PEAK_DAY;
  const ticks = Math.ceil((i.deliveryMinutes * 60) / i.sourceTickSeconds);
  const ingestRequests = Math.ceil(i.deliveryEvents / i.maxBatchEvents) + ticks * i.sources;
  const rolls = Math.ceil((i.deliveryMinutes * 60) / i.landingRollSeconds) + 2;
  const runs = Math.min(Math.ceil((i.deliveryMinutes * 60) / Math.max(i.runMinIntervalSeconds, 1)), i.autoRunsMaxPerDay) + P.extraRuns;
  const crons = i.cronExpressions.reduce((n, e) => n + cronRunsPerDay(e), 0);
  const workerRequests = ingestRequests + runs * P.runnerCallsPerRun + crons + rolls + runs * P.stepsPerCommittedRun + P.operatorRequests;
  const doRequests = ingestRequests + rolls * 5 + crons + runs * (P.runnerCallsPerRun + P.workflowDoCallsPerRun) + 100 + P.operatorRequests;
  const freshnessBuckets = i.deliveryMinutes * 6;
  const rowsWritten = Math.ceil(
    (2 * ingestRequests + 4 * rolls + P.coordinatorRowsPerRun * runs + freshnessBuckets + 5 * rolls + 60 + crons) * P.indexOverhead,
  );
  const requestsPerRoll = Math.ceil(ingestRequests / rolls);
  const rowsRead = runs * 100 + crons * 10 + ingestRequests * 2 + rolls * (requestsPerRoll + 10) + P.operatorRequests * 50;
  const duration = Math.ceil((2 * (i.deliveryMinutes + P.activeObjectMinutesExtra) * 60 + crons * P.secondsBilledPerCronActivation) * P.objectMemoryGb);
  // BigQuery, unclamped: prod:e2e and the other go-live checks, then the drill scenarios the monthly guard
  // lets into the same month (it stops before one that would pass the cap); the rest run the next month.
  const transform = P.bqBytesPerTransform;
  const otherBytes = P.goLiveOtherTransforms * transform;
  const perScenario = (i.drillChunks + 2) * transform;
  const roomForDrill = i.bqMonthlyBytesCap - runs * transform - otherBytes;
  const drillThisMonth = Math.max(0, Math.min(i.drillScenarios, Math.floor(roomForDrill / perScenario)));
  const bqGoLiveMonth = runs * transform + otherBytes + drillThisMonth * perScenario;
  const bqNextMonth = (i.drillScenarios - drillThisMonth) * perScenario + otherBytes;
  const bqMonth = Math.max(bqGoLiveMonth, bqNextMonth);
  const r2Bytes = i.deliveryEvents * P.ndjsonBytesPerRecord + P.icebergAndReportBytes;
  const row = (id: keyof typeof ALLOWANCES, estimate: number, basis: string, gated = true): BudgetRow => {
    const a: Allowance = ALLOWANCES[id];
    return { id, label: a.label, estimate, limit: Math.floor(a.value * a.share), allowance: a.value, unit: a.unit, scope: a.scope, share: a.share, basis, gated };
  };
  return [
    row("workerRequests", workerRequests, `ingest ${ingestRequests} (${i.deliveryEvents} events / ${i.maxBatchEvents} + ${ticks} ticks x ${i.sources} sources), runner ${runs * P.runnerCallsPerRun}, cron ${crons}, queue ${rolls}, Workflow ${runs * P.stepsPerCommittedRun}, operator ${P.operatorRequests}`),
    row("workflowSteps", runs * P.stepsWorstRun, `${runs} runs x ${P.stepsWorstRun} steps (worst case; a committed run uses ${P.stepsPerCommittedRun})`),
    row("queueOperations", 3 * rolls * (1 + i.queueMaxRetries), `${rolls} rolls x 3 operations x (1 + ${i.queueMaxRetries} retries)`),
    row("doRequests", doRequests, `ingest ${ingestRequests}, rolls and consumer ${rolls * 5}, cron ${crons}, runner and Workflow ${runs * (P.runnerCallsPerRun + P.workflowDoCallsPerRun)}, alarms 100, operator ${P.operatorRequests}`),
    row("doRowsWritten", rowsWritten, `LandingRoller 2 x ${ingestRequests} + 4 x ${rolls}, Coordinator ${P.coordinatorRowsPerRun} x ${runs} runs + ${freshnessBuckets} freshness + rolls, AI and flushes, x ${P.indexOverhead} for indexes`),
    row("doRowsRead", rowsRead, "indexed queries only"),
    row("doDuration", duration, `2 objects active ${i.deliveryMinutes + P.activeObjectMinutesExtra} min + ${crons} cron activations x ${P.secondsBilledPerCronActivation} s, at ${P.objectMemoryGb * 1000} MB`),
    row("workersAiNeurons", i.aiDailyNeuronCap, "the daily neuron cap (the ask eval stops there)"),
    row("workersLogs", workerRequests + doRequests, "one event per Worker and Durable Object invocation"),
    row("cronTriggers", i.cronExpressions.length, "cron expressions in the production config"),
    row("aiGateways", 1, "gateway peoplelake"),
    row("accessSeats", i.humanSeats, "the owner and the persona addresses"),
    row("serviceTokens", i.serviceTokens, "three sources, the runner and the doctor"),
    row("envVars", i.envVars, "production vars and secrets"),
    row("ingestBatchEvents", i.maxBatchEvents, "MAX_BATCH_EVENTS (npm run bench:ingest measures the CPU)"),
    row("r2Storage", r2Bytes, `${i.deliveryEvents} records x ${P.ndjsonBytesPerRecord} bytes of landing NDJSON + Iceberg data and reports`),
    row("r2ClassA", rolls + 250 + 20 + runs * 3, "roll puts, Iceberg writes, lists and reports on the peak day"),
    row("r2ClassB", rolls + 250 + 200, "roll reads, Iceberg reads and report reads on the peak day"),
    row("catalogOperations", runs * 2 + rolls * 2, "2 per load and 2 per committed roll on the peak day"),
    row(
      "bigqueryQueries",
      bqMonth,
      `the larger of two months at 3 GB a transform: go-live ${Math.round(bqGoLiveMonth / 1e9)} GB (prod:e2e ${runs}, other checks ${P.goLiveOtherTransforms}, ${drillThisMonth} of ${i.drillScenarios} drill scenarios x ${i.drillChunks + 2} under the ${i.bqMonthlyBytesCap / 1e9} GB guard) and the next ${Math.round(bqNextMonth / 1e9)} GB (the remaining ${i.drillScenarios - drillThisMonth} of the drill), not clamped`,
    ),
    row("bigqueryStorage", P.bqStorageBytes, "raw table and models of one full delivery"),
    row("cloudBuildMinutes", P.buildsPerMonth * P.minutesPerBuild, `${P.buildsPerMonth} builds of about ${P.minutesPerBuild} minutes`),
    // Reported, not gated: past the 25% planning share (SPEC 29.5), cents a month beyond the free tier.
    row("artifactRegistryStorage", P.runnerImageBytes * P.runnerImagesKept, `${P.runnerImagesKept} runner image of about ${P.runnerImageBytes / 1e6} MB (measured 2026-10-11, gzip of \`docker save\`, linux/arm64); about $0.10 per GB-month beyond the free 0.5 GB`, false),
    row("secretVersions", P.secretActiveVersions, `one active version of each of the ${P.secretActiveVersions} runner secrets (bootstrap destroys superseded versions); $0.06 per version-month beyond the free 6`, false),
  ];
}

/** Rows whose estimate passes the planning share (`npm run budget -- --check` fails on any). */
export function overBudget(rows: readonly BudgetRow[]): BudgetRow[] {
  return rows.filter((r) => r.gated && r.estimate > r.limit);
}
