import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp, requireRole } from "../../src/worker/app.ts";
import { call, devToken } from "../helpers/tokens.ts";

describe("Access JWT verification (same code for dev keys and the team JWKS)", () => {
  it("serves /v1/health without a token", async () => {
    const res = await call("/v1/health", null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, environment: "local", lake_mode: "local" });
  });

  it("rejects a missing token with 401", async () => {
    const res = await call("/v1/health/auth", null);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "missing" });
  });

  it.each([
    ["a foreign signing key", { foreignKey: true }],
    ["the wrong issuer", { issuer: "https://attacker.cloudflareaccess.com" }],
    ["the wrong audience", { audience: "someone-else" }],
  ])("rejects a token with %s", async (_label, opts) => {
    const res = await call("/v1/health/auth", "operator", {}, opts);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const res = await call("/v1/health/auth", "runner", {}, { expiresInSeconds: -60 });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "expired" });
  });

  it("ignores the CF_Authorization cookie", async () => {
    const token = await devToken("operator");
    const res = await SELF.fetch("http://127.0.0.1/v1/health/auth", { headers: { Cookie: `CF_Authorization=${token}` } });
    expect(res.status).toBe(401);
  });

  it("maps service tokens by common_name and people by email", async () => {
    const runner = await (await call("/v1/health/auth", "runner")).json();
    expect(runner).toEqual({ principal: { kind: "service", id: "runner.access" }, roles: ["runner"] });
    const hris = await (await call("/v1/health/auth", "hris")).json();
    expect(hris).toMatchObject({ roles: ["source:hris"] });
    const operator = await (await call("/v1/health/auth", "operator")).json();
    expect(operator).toEqual({ principal: { kind: "user", id: "dev@peoplelake.local" }, roles: ["viewer", "operator"] });
    const stranger = await (await call("/v1/health/auth", "stranger")).json();
    expect(stranger).toMatchObject({ roles: [] });
  });
});

describe("role gates", () => {
  const app = createApp((a) => {
    a.get("/gated/operator", requireRole("operator"), (c) => c.json({ ok: true }));
    a.get("/gated/viewer-or-runner", requireRole("viewer", "runner"), (c) => c.json({ ok: true }));
  });
  const fetchAs = async (path: string, who: Parameters<typeof devToken>[0]) =>
    app.fetch(
      new Request(`http://127.0.0.1${path}`, { headers: { "Cf-Access-Jwt-Assertion": await devToken(who) } }),
      env,
    );

  it("allows a principal holding one of the roles", async () => {
    expect((await fetchAs("/gated/operator", "operator")).status).toBe(200);
    expect((await fetchAs("/gated/viewer-or-runner", "viewer")).status).toBe(200);
    expect((await fetchAs("/gated/viewer-or-runner", "runner")).status).toBe(200);
  });

  it("returns 403 for an authenticated principal without the role", async () => {
    expect((await fetchAs("/gated/operator", "viewer")).status).toBe(403);
    expect((await fetchAs("/gated/operator", "runner")).status).toBe(403);
    expect((await fetchAs("/gated/operator", "unmappedService")).status).toBe(403);
    expect((await fetchAs("/gated/viewer-or-runner", "hris")).status).toBe(403);
  });
});
