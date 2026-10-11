// AiProvider (SPEC 13): a question becomes a validated MetricQuery; numbers never come from the model.
//   workers-ai         production: Workers AI through AI Gateway, JSON schema output, one repair retry,
//                      max_tokens on every call and a reservation against the daily neuron cap first
//   openai-compatible  local: llama-server (Qwen3-1.7B) on 127.0.0.1:8150, JSON schema output
//   stub               CI default: a deterministic rule parser, labeled as such in every answer
import { z } from "zod";
import { AI_MODEL, aiNeurons, aiReservation } from "../../shared/free-budget.ts";
import { METRIC_IDS, type MetricId } from "../../shared/metrics.ts";
import type { AppConfig } from "../config.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";

export const WINDOW_START = "2023-01";
export const WINDOW_END = "2025-12";
const Month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);

export const MetricQuery = z
  .object({
    metric: z.enum(METRIC_IDS),
    department_id: z.string().regex(/^(ALL|D(0[1-9]|1[0-2]))$/),
    start_month: Month,
    end_month: Month,
  })
  .strict()
  .refine((q) => q.start_month <= q.end_month, "start_month must not be after end_month")
  .refine((q) => q.start_month >= WINDOW_START && q.end_month <= WINDOW_END, "months must be within 2023-01 and 2025-12");
export type MetricQuery = z.infer<typeof MetricQuery>;

/** JSON schema handed to the model (the refinements are re-checked with zod afterwards). */
export const METRIC_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["metric", "department_id", "start_month", "end_month"],
  properties: {
    metric: { type: "string", enum: [...METRIC_IDS] },
    department_id: { type: "string", pattern: "^(ALL|D(0[1-9]|1[0-2]))$" },
    start_month: { type: "string", pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$" },
    end_month: { type: "string", pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$" },
  },
} as const;

export const DEPARTMENTS: Record<string, string> = {
  D01: "Engineering",
  D02: "Product",
  D03: "Design",
  D04: "Sales",
  D05: "Marketing",
  D06: "Customer Success",
  D07: "Finance",
  D08: "People",
  D09: "Legal",
  D10: "Operations",
  D11: "Data",
  D12: "Security",
};

export const SYSTEM_PROMPT = [
  "You translate a question about workforce metrics into JSON with keys metric, department_id, start_month, end_month.",
  `metric is one of: ${METRIC_IDS.join(", ")} (headcount and fte are month-end values; hires and departures are monthly counts; offer_acceptance_rate is accepted / (accepted + declined) by decision month).`,
  `department_id is ALL for the whole company or one of: ${Object.entries(DEPARTMENTS).map(([id, n]) => `${id} ${n}`).join(", ")}.`,
  "Months are YYYY-MM between 2023-01 and 2025-12. A quarter Qn of year Y covers months 3n-2 to 3n. A year covers 01 to 12. Without a period, use 2023-01 to 2025-12.",
  "Answer with the JSON object only.",
].join(" ");

export class AskError extends Error {
  override name = "AskError";
  readonly status: 400 | 422 | 429 | 502;
  constructor(status: 400 | 422 | 429 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

/** This repo's share of the account's Workers AI neurons (SPEC 29.4.5), kept by the Coordinator. */
export interface NeuronBudget {
  reserve(neurons: number): Promise<{ ok: boolean; used: number; cap: number }>;
  adjust(delta: number): Promise<unknown>;
}

/** Calls and reserved neurons of one question (the eval sums them). */
export interface AiUsage {
  calls: number;
  neurons_reserved: number;
}

export interface AiProvider {
  readonly name: "stub" | "openai-compatible" | "workers-ai";
  toQuery(question: string): Promise<MetricQuery>;
}

function validated(raw: unknown, provider: string): MetricQuery {
  let value = raw;
  if (typeof value === "string") {
    const text = value.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try {
      value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    } catch {
      throw new AskError(422, `${provider} did not return JSON`);
    }
  }
  const parsed = MetricQuery.safeParse(value);
  if (!parsed.success) throw new AskError(422, `${provider} returned an invalid query: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

// -- stub: deterministic rules --------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function metricOf(q: string): MetricId {
  if (/accept/.test(q)) return "offer_acceptance_rate";
  if (/\bfte\b|full[- ]time equivalent/.test(q)) return "fte";
  if (/\bhire|hiring|\bhired/.test(q)) return "hires";
  // "depart" but not "department", which names a department rather than the metric.
  if (/depart(?!ment)|attrition|terminat|left|exits?\b|leavers/.test(q)) return "departures";
  return "headcount";
}

function departmentOf(q: string): string {
  const byId = /\bd(0[1-9]|1[0-2])\b/.exec(q);
  if (byId) return `D${byId[1]}`;
  const found = Object.entries(DEPARTMENTS).find(([, name]) => {
    const n = name.toLowerCase();
    // "people" is also an ordinary word ("people left"): count it only in a department context.
    if (n === "people") return /\b(in|for|of|the)\s+people\s+(department|team|org)|\bpeople\s+(department|team|org)\b/.test(q);
    return new RegExp(`\\b${n}\\b`).test(q);
  });
  return found ? found[0] : "ALL";
}

function periodOf(q: string): [string, string] {
  const quarter = /\bq([1-4])\s*(20\d{2})\b/.exec(q) ?? /\b(20\d{2})\s*q([1-4])\b/.exec(q);
  if (quarter) {
    const [n, y] = quarter[0].startsWith("q") ? [Number(quarter[1]), quarter[2]] : [Number(quarter[2]), quarter[1]];
    return [`${y}-${pad(3 * n - 2)}`, `${y}-${pad(3 * n)}`];
  }
  const monthYear = [...q.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/g)];
  if (monthYear.length >= 1) {
    const toKey = (m: RegExpMatchArray) => `${m[2]}-${pad(MONTHS.indexOf(m[1] ?? "") + 1)}`;
    const keys = monthYear.map(toKey).sort();
    return [keys[0] ?? WINDOW_START, keys[keys.length - 1] ?? WINDOW_END];
  }
  const years = [...q.matchAll(/\b(202[3-5])\b/g)].map((m) => m[1] ?? "");
  if (years.length >= 1) {
    const sorted = years.sort();
    return [`${sorted[0]}-01`, `${sorted[sorted.length - 1]}-12`];
  }
  return [WINDOW_START, WINDOW_END];
}

export class StubProvider implements AiProvider {
  readonly name = "stub" as const;
  async toQuery(question: string): Promise<MetricQuery> {
    const q = question.toLowerCase();
    const [start, end] = periodOf(q);
    return validated({ metric: metricOf(q), department_id: departmentOf(q), start_month: start, end_month: end }, this.name);
  }
}

// -- openai-compatible (llama-server) -------------------------------------------------------------

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible" as const;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  constructor(baseUrl: string, model = "local", fetchImpl?: typeof fetch) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#model = model;
    // Always call fetch as a plain function: `this.#fetch(...)` would run workerd's fetch with the
    // provider as `this`, which throws "Illegal invocation" (found by `peoplelake eval ask --provider llama`).
    const f = fetchImpl ?? fetch;
    this.#fetch = (input, init) => f(input, init);
  }
  async toQuery(question: string): Promise<MetricQuery> {
    const body = JSON.stringify({
      model: this.#model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${question} /no_think` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "metric_query", strict: true, schema: METRIC_QUERY_SCHEMA } },
    });
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch (err) {
      throw new AskError(502, `local LLM unreachable at ${this.#baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new AskError(502, `local LLM HTTP ${res.status}`);
    const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return validated(out.choices?.[0]?.message?.content ?? "", this.name);
  }
}

// -- workers-ai through AI Gateway ------------------------------------------------------------------

export interface AiBinding {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  aiGatewayLogId?: string | null;
}

/** The repair note names the rejection briefly, so the note stays near 100 characters. */
export function repairNote(reason: string): string {
  return `Your previous answer was rejected (${reason.slice(0, 40)}). Reply with the JSON object only.`;
}

export class WorkersAiProvider implements AiProvider {
  readonly name = "workers-ai" as const;
  readonly #ai: AiBinding;
  readonly #model: string;
  readonly #gatewayId: string;
  readonly #maxTokens: number;
  readonly #budget: NeuronBudget | null;
  #usage: AiUsage = { calls: 0, neurons_reserved: 0 };
  constructor(ai: AiBinding, model: string, gatewayId: string, options: { maxTokens?: number; budget?: NeuronBudget | null } = {}) {
    this.#ai = ai;
    this.#model = model;
    this.#gatewayId = gatewayId;
    this.#maxTokens = options.maxTokens ?? 96;
    this.#budget = options.budget ?? null;
  }

  /** Calls and neurons reserved by the last toQuery. */
  usage(): AiUsage {
    return { ...this.#usage };
  }

  async #call(question: string, repair: string | null): Promise<unknown> {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
      ...(repair ? [{ role: "user", content: repairNote(repair) }] : []),
    ];
    const schema = { type: "json_schema", json_schema: METRIC_QUERY_SCHEMA };
    const inputChars = messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(schema).length;
    const reserved = aiReservation(this.#model, inputChars, this.#maxTokens);
    if (this.#budget) {
      const r = await this.#budget.reserve(reserved);
      if (!r.ok) throw new AskError(429, `ai_budget: ${r.used} of ${r.cap} neurons used today (UTC); try again tomorrow`);
    }
    this.#usage.calls++;
    this.#usage.neurons_reserved += reserved;
    const out = (await this.#ai.run(
      this.#model,
      { messages, response_format: schema, max_tokens: this.#maxTokens },
      { gateway: { id: this.#gatewayId } },
    )) as { response?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    // If Workers AI reports token usage, correct the reservation to the neurons those tokens cost.
    const prompt = out.usage?.prompt_tokens;
    const completion = out.usage?.completion_tokens;
    if (this.#budget && typeof prompt === "number" && typeof completion === "number") {
      const actual = Math.ceil(aiNeurons(this.#model, prompt, completion));
      if (actual !== reserved) {
        await this.#budget.adjust(actual - reserved);
        this.#usage.neurons_reserved += actual - reserved;
      }
    }
    return out.response ?? out;
  }

  async toQuery(question: string): Promise<MetricQuery> {
    this.#usage = { calls: 0, neurons_reserved: 0 };
    try {
      return validated(await this.#call(question, null), this.name);
    } catch (first) {
      if (first instanceof AskError && first.status === 429) throw first;
      // JSON mode can fail ("JSON Mode couldn't be met"): one repair retry, then 422.
      const reason = first instanceof Error ? first.message : String(first);
      try {
        return validated(await this.#call(question, reason), this.name);
      } catch (second) {
        if (second instanceof AskError) throw second;
        throw new AskError(422, `workers-ai could not produce a valid query: ${second instanceof Error ? second.message : String(second)}`);
      }
    }
  }
}

/** The Coordinator-backed neuron ledger (one per UTC day, capped by AI_DAILY_NEURON_CAP). */
export function coordinatorNeuronBudget(env: Env): NeuronBudget {
  return {
    reserve: (neurons) => coordinatorStub(env).reserveNeurons(neurons),
    adjust: (delta) => coordinatorStub(env).adjustNeurons(delta),
  };
}

export function makeProvider(config: AppConfig, env: Env, fetchImpl?: typeof fetch): AiProvider {
  switch (config.ai.provider) {
    case "workers-ai": {
      const ai = (env as unknown as { AI?: AiBinding }).AI;
      if (!ai) throw new AskError(502, "AI_PROVIDER=workers-ai needs the AI binding (production only)");
      return new WorkersAiProvider(ai, config.ai.model ?? AI_MODEL, config.ai.gatewayId ?? "peoplelake", {
        maxTokens: config.ai.maxTokens,
        budget: coordinatorNeuronBudget(env),
      });
    }
    case "openai-compatible":
      return new OpenAiCompatibleProvider(config.ai.llmBaseUrl ?? "http://127.0.0.1:8150/v1", "local", fetchImpl);
    default:
      return new StubProvider();
  }
}
