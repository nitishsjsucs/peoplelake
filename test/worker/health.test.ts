import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /v1/health", () => {
  it("reports environment and lake mode only", async () => {
    const res = await SELF.fetch("http://127.0.0.1/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, version: "0.1.0", environment: "local", lake_mode: "local" });
  });
});
