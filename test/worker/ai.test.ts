import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { answer, mountAsk } from "../../src/worker/ai/ask.ts";
import { type AiBinding, AskError, OpenAiCompatibleProvider, StubProvider, WorkersAiProvider } from "../../src/worker/ai/providers.ts";
import { createApp } from "../../src/worker/app.ts";
import { call, devToken } from "../helpers/tokens.ts";

afterEach(async () => {
  await reset();
});

class MockAi implements AiBinding {
  calls: { model: string; inputs: any; options: any }[] = [];
  aiGatewayLogId: string | null = null;
  responses: unknown[];
  constructor(...responses: unknown[]) {
    this.responses = responses;
  }
  async run(model: string, inputs: unknown, options?: unknown): Promise<unknown> {
    this.calls.push({ model, inputs, options });
    this.aiGatewayLogId = "log-123";
    return { response: this.responses.shift() };
  }
}

describe("stub provider (deterministic rules, CI default)", () => {
  const stub = new StubProvider();
  it.each([
    ["What was headcount in Q2 2024?", { metric: "headcount", department_id: "ALL", start_month: "2024-04", end_month: "2024-06" }],
    ["How many hires did Engineering make in 2023?", { metric: "hires", department_id: "D01", start_month: "2023-01", end_month: "2023-12" }],
    ["Offer acceptance rate for Sales between March 2024 and May 2024", { metric: "offer_acceptance_rate", department_id: "D04", start_month: "2024-03", end_month: "2024-05" }],
    ["FTE in D11 in December 2025", { metric: "fte", department_id: "D11", start_month: "2025-12", end_month: "2025-12" }],
    ["attrition", { metric: "departures", department_id: "ALL", start_month: "2023-01", end_month: "2025-12" }],
    ["How many people left the company in 2025?", { metric: "departures", department_id: "ALL", start_month: "2025-01", end_month: "2025-12" }],
    ["Headcount of the People team in March 2024", { metric: "headcount", department_id: "D08", start_month: "2024-03", end_month: "2024-03" }],
  ])("%s", async (question, expected) => {
    expect(await stub.toQuery(question)).toEqual(expected);
  });
});

describe("Workers AI provider", () => {
  it("calls the model through AI Gateway with a JSON schema response format", async () => {
    const ai = new MockAi({ metric: "hires", department_id: "D02", start_month: "2024-01", end_month: "2024-03" });
    const provider = new WorkersAiProvider(ai, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "peoplelake");
    expect(await provider.toQuery("hires in product in Q1 2024")).toEqual({ metric: "hires", department_id: "D02", start_month: "2024-01", end_month: "2024-03" });
    const call0 = ai.calls[0];
    expect(call0?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(call0?.options).toEqual({ gateway: { id: "peoplelake" } });
    expect(call0?.inputs.response_format.type).toBe("json_schema");
    expect(call0?.inputs.response_format.json_schema.required).toEqual(["metric", "department_id", "start_month", "end_month"]);
    expect(ai.aiGatewayLogId).toBe("log-123");
  });

  it("repairs once, then fails with 422", async () => {
    const ok = new MockAi("not json", JSON.stringify({ metric: "fte", department_id: "ALL", start_month: "2025-01", end_month: "2025-02" }));
    expect((await new WorkersAiProvider(ok, "m", "g").toQuery("fte")).metric).toBe("fte");
    expect(ok.calls).toHaveLength(2);
    const bad = new MockAi("nope", { metric: "salary", department_id: "ALL", start_month: "2025-01", end_month: "2025-01" });
    await expect(new WorkersAiProvider(bad, "m", "g").toQuery("x")).rejects.toMatchObject({ status: 422 });
  });

  it("rejects queries outside the window or with reversed months", async () => {
    const ai = new MockAi({ metric: "hires", department_id: "ALL", start_month: "2022-01", end_month: "2022-02" }, { metric: "hires", department_id: "ALL", start_month: "2025-05", end_month: "2025-01" });
    await expect(new WorkersAiProvider(ai, "m", "g").toQuery("x")).rejects.toBeInstanceOf(AskError);
  });
});

describe("openai-compatible provider (local llama-server)", () => {
  it("sends a chat completion with a strict JSON schema and strips thinking", async () => {
    const seen: { url: string; body: any }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ choices: [{ message: { content: '<think>q2 is apr to jun</think>{"metric":"headcount","department_id":"ALL","start_month":"2024-04","end_month":"2024-06"}' } }] });
    }) as typeof fetch;
    const provider = new OpenAiCompatibleProvider("http://127.0.0.1:8150/v1/", "local", fetchImpl);
    expect(await provider.toQuery("headcount Q2 2024")).toMatchObject({ start_month: "2024-04", end_month: "2024-06" });
    expect(seen[0]?.url).toBe("http://127.0.0.1:8150/v1/chat/completions");
    expect(seen[0]?.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "metric_query", strict: true } });
    expect(seen[0]?.body.temperature).toBe(0);
  });
});

describe("POST /api/ask", () => {
  const snapshot = {
    run_id: "r-x-000001",
    rows: [
      { month: "2024-03-01", department_id: "ALL", headcount: "4100", hires: "60" },
      { month: "2024-04-01", department_id: "ALL", headcount: "4110", hires: "70" },
      { month: "2024-05-01", department_id: "ALL", headcount: "4120", hires: "71" },
      { month: "2024-06-01", department_id: "ALL", headcount: "4130", hires: "72" },
      { month: "2024-04-01", department_id: "D01", headcount: "300", hires: "5" },
    ],
  };

  it("answers only from the committed snapshot", async () => {
    await env.REPORTS_BUCKET.put("reports/metrics/latest.json", JSON.stringify(snapshot));
    const res = await call("/api/ask", "viewer", { method: "POST", body: JSON.stringify({ question: "What was headcount in Q2 2024?" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "stub",
      provider_note: "deterministic rule parser (no model)",
      query: { metric: "headcount", department_id: "ALL", start_month: "2024-04", end_month: "2024-06" },
      source: { key: "reports/metrics/latest.json", run_id: "r-x-000001" },
      values: [
        { month: "2024-04", value: "4110" },
        { month: "2024-05", value: "4120" },
        { month: "2024-06", value: "4130" },
      ],
    });
  });

  it("needs a viewer, a question and a committed snapshot", async () => {
    expect((await call("/api/ask", "runner", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await call("/api/ask", "viewer", { method: "POST", body: JSON.stringify({ question: "x" }) })).status).toBe(404);
    await env.REPORTS_BUCKET.put("reports/metrics/latest.json", JSON.stringify(snapshot));
    expect((await call("/api/ask", "viewer", { method: "POST", body: JSON.stringify({ question: "" }) })).status).toBe(400);
  });

  it("filters by department and month", () => {
    expect(answer({ metric: "hires", department_id: "D01", start_month: "2024-01", end_month: "2024-12" }, snapshot.rows)).toEqual([{ month: "2024-04", value: "5" }]);
  });

  it("uses the Workers AI binding when AI_PROVIDER=workers-ai", async () => {
    await env.REPORTS_BUCKET.put("reports/metrics/latest.json", JSON.stringify(snapshot));
    const ai = new MockAi({ metric: "hires", department_id: "ALL", start_month: "2024-03", end_month: "2024-03" });
    const app = createApp(mountAsk);
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/ask", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await devToken("viewer") },
        body: JSON.stringify({ question: "hires in March 2024" }),
      }),
      { ...env, AI_PROVIDER: "workers-ai", AI_MODEL: "@cf/test/model", AI_GATEWAY_ID: "peoplelake", AI: ai },
    );
    expect(await res.json()).toMatchObject({ provider: "workers-ai", values: [{ month: "2024-03", value: "60" }] });
    expect(ai.calls[0]?.options).toEqual({ gateway: { id: "peoplelake" } });
  });
});

describe("POST /api/ask/query (translation only, scored by peoplelake eval ask)", () => {
  it("returns the provider and the validated query without a committed snapshot", async () => {
    const res = await call("/api/ask/query", "viewer", { method: "POST", body: JSON.stringify({ question: "Hires in Engineering in Q2 2023" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "stub",
      model: null,
      query: { metric: "hires", department_id: "D01", start_month: "2023-04", end_month: "2023-06" },
    });
  });

  it("needs a viewer or operator and a question", async () => {
    expect((await call("/api/ask/query", "runner", { method: "POST", body: JSON.stringify({ question: "x" }) })).status).toBe(403);
    expect((await call("/api/ask/query", "hris", { method: "POST", body: JSON.stringify({ question: "x" }) })).status).toBe(403);
    expect((await call("/api/ask/query", "operator", { method: "POST", body: JSON.stringify({ question: " " }) })).status).toBe(400);
    expect((await call("/api/ask/query", "viewer", { method: "POST", body: JSON.stringify({ question: "x".repeat(501) }) })).status).toBe(400);
  });

  it("reports the Workers AI model and maps an invalid model answer to 422", async () => {
    const app = createApp(mountAsk);
    const ask = async (ai: MockAi) =>
      app.fetch(
        new Request("http://127.0.0.1/api/ask/query", {
          method: "POST",
          headers: { "Cf-Access-Jwt-Assertion": await devToken("viewer") },
          body: JSON.stringify({ question: "fte in 2025" }),
        }),
        { ...env, AI_PROVIDER: "workers-ai", AI_MODEL: "@cf/test/model", AI_GATEWAY_ID: "peoplelake", AI: ai },
      );
    const ok = await ask(new MockAi({ metric: "fte", department_id: "ALL", start_month: "2025-01", end_month: "2025-12" }));
    expect(await ok.json()).toEqual({ provider: "workers-ai", model: "@cf/test/model", query: { metric: "fte", department_id: "ALL", start_month: "2025-01", end_month: "2025-12" } });
    const bad = await ask(new MockAi("nope", "still nope"));
    expect(bad.status).toBe(422);
  });
});

describe("GET /api/ops/ai", () => {
  it("reports that local runs have no Workers AI binding", async () => {
    const res = await call("/api/ops/ai", "operator");
    expect(await res.json()).toMatchObject({ ok: false, provider: "stub" });
    expect((await call("/api/ops/ai", "viewer")).status).toBe(403);
  });

  it("makes one call through the gateway and reports the gateway log id", async () => {
    const { mountOpsApi } = await import("../../src/worker/api/ops.ts");
    const ai = new MockAi("ok");
    const app = createApp(mountOpsApi);
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/ops/ai", { headers: { "Cf-Access-Jwt-Assertion": await devToken("operator") } }),
      { ...env, AI_PROVIDER: "workers-ai", AI_MODEL: "@cf/test/model", AI_GATEWAY_ID: "peoplelake", AI: ai },
    );
    expect(await res.json()).toEqual({ ok: true, gateway_log_id_present: true });
    expect(ai.calls[0]?.options).toEqual({ gateway: { id: "peoplelake" } });
  });
});
