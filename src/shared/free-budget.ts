// Workers Free plan budget (SPEC 29): the production guard values, the bounds parseConfig enforces in
// production, and the constants the usage estimates use. Shared by the Worker, the scripts and the tests,
// so a change that would pass a Free allowance fails a test instead of reaching production.

/** Production values of the run guards (SPEC 29.6); wrangler.jsonc env.production must equal these. */
export const PRODUCTION_GUARDS = {
  RUN_MIN_INTERVAL_SECONDS: 240,
  FAILURE_BACKOFF_BASE_MINUTES: 5,
  FAILURE_BACKOFF_MAX_MINUTES: 360,
  AUTO_RUNS_MAX_PER_DAY: 30,
  BQ_MONTHLY_BYTES_CAP: 275_000_000_000,
  HEARTBEAT_MINUTES: 0,
} as const;

/** parseConfig refuses production values outside these bounds (SPEC 29.6). */
export const GUARD_BOUNDS = {
  runMinIntervalSecondsAtLeast: 240,
  failureBackoffBaseMinutesAtLeast: 5,
  autoRunsMaxPerDayAtMost: 30,
  bqMonthlyBytesCapAtMost: 275_000_000_000,
  heartbeatMinutesAtMost: 0,
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
