import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { CloudRunDispatcher, cloudRunJobUrl, PollDispatcher } from "../../src/worker/orchestration/dispatcher.ts";
import { accessToken, type CachedToken, parseServiceAccountKey, SCOPE, TOKEN_URL, type TokenCache } from "../../src/worker/orchestration/gcp-token.ts";

async function serviceAccount() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const key = { client_email: "pl-dispatcher@peoplelake-1.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey), private_key_id: "kid-123" };
  return { key, publicKey };
}

function memoryCache(initial: CachedToken | null = null): TokenCache & { value: CachedToken | null } {
  const cache = {
    value: initial,
    get: async () => cache.value,
    set: async (t: CachedToken) => {
      cache.value = t;
    },
  };
  return cache;
}

type Call = { url: string; init: RequestInit | undefined };

function fakeGoogle(opts: { runStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URL) return Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600 });
    if (url.endsWith(":run")) {
      if (opts.runStatus && opts.runStatus >= 400) return new Response("permission denied", { status: opts.runStatus });
      return Response.json({ name: "projects/peoplelake-1/locations/us-central1/operations/op-1" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("GCP service-account token", () => {
  it("signs an RS256 assertion with the key id and exchanges it with the JWT bearer grant", async () => {
    const { key, publicKey } = await serviceAccount();
    const google = fakeGoogle();
    const token = await accessToken(key, memoryCache(), google.fetchImpl, 1_800_000_000_000);
    expect(token).toMatchObject({ token: "tok-1", cached: false, expires_at: 1_800_000_000_000 + 3_600_000 });
    const call = google.calls[0];
    expect(call?.url).toBe(TOKEN_URL);
    const form = new URLSearchParams(String(call?.init?.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { payload, protectedHeader } = await jwtVerify(form.get("assertion") ?? "", publicKey, {
      issuer: key.client_email,
      subject: key.client_email,
      audience: TOKEN_URL,
      currentDate: new Date(1_800_000_000_000),
    });
    expect(protectedHeader).toEqual({ alg: "RS256", kid: "kid-123", typ: "JWT" });
    expect(payload["scope"]).toBe(SCOPE);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);
  });

  it("reuses a cached token until 5 minutes before expiry", async () => {
    const { key } = await serviceAccount();
    const google = fakeGoogle();
    const cache = memoryCache({ token: "cached", expires_at: 1_000_000 + 10 * 60_000 });
    expect((await accessToken(key, cache, google.fetchImpl, 1_000_000)).token).toBe("cached");
    expect(google.calls).toHaveLength(0);
    expect((await accessToken(key, cache, google.fetchImpl, 1_000_000 + 6 * 60_000)).token).toBe("tok-1");
    expect(cache.value?.token).toBe("tok-1");
  });

  it("rejects something that is not a service account key", () => {
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow(/service account key/);
  });
});

describe("dispatchers", () => {
  it("starts the Cloud Run job with an empty body and records the operation", async () => {
    const { key } = await serviceAccount();
    const google = fakeGoogle();
    const dispatcher = new CloudRunDispatcher({ project: "peoplelake-1", region: "us-central1", job: "peoplelake-runner", key, tokens: memoryCache(), fetch: google.fetchImpl });
    const res = await dispatcher.dispatch();
    expect(res).toEqual({ mode: "cloudrun", ref: "projects/peoplelake-1/locations/us-central1/operations/op-1" });
    const run = google.calls[1];
    expect(run?.url).toBe("https://run.googleapis.com/v2/projects/peoplelake-1/locations/us-central1/jobs/peoplelake-runner:run");
    expect(run?.url).toBe(cloudRunJobUrl({ project: "peoplelake-1", region: "us-central1", job: "peoplelake-runner" }));
    expect(run?.init?.method).toBe("POST");
    expect(run?.init?.body).toBe("{}");
    expect(new Headers(run?.init?.headers).get("authorization")).toBe("Bearer tok-1");
  });

  it("surfaces a 4xx from Cloud Run", async () => {
    const { key } = await serviceAccount();
    const google = fakeGoogle({ runStatus: 403 });
    const dispatcher = new CloudRunDispatcher({ project: "p", region: "us-central1", job: "j", key, tokens: memoryCache(), fetch: google.fetchImpl });
    await expect(dispatcher.dispatch()).rejects.toThrow(/HTTP 403 permission denied/);
  });

  it("does nothing in poll mode (the local runner polls)", async () => {
    expect(await new PollDispatcher().dispatch()).toEqual({ mode: "poll" });
  });
});
