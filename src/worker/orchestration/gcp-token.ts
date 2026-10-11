// Google service-account JWT bearer grant with jose (SPEC 8.3): an RS256 assertion signed with the
// dispatcher key, exchanged at oauth2.googleapis.com/token for an access token, cached until 5 minutes
// before expiry. The key can only start the Cloud Run job (roles/run.jobsExecutor on that job).
import { importPKCS8, SignJWT } from "jose";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id: string;
}

export interface CachedToken {
  token: string;
  expires_at: number;
}

export interface TokenCache {
  get(): Promise<CachedToken | null>;
  set(token: CachedToken): Promise<void>;
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const key = JSON.parse(raw) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key || !key.private_key_id) {
    throw new Error("GCP_DISPATCHER_KEY is not a service account key (client_email, private_key, private_key_id)");
  }
  return { client_email: key.client_email, private_key: key.private_key, private_key_id: key.private_key_id };
}

export async function signAssertion(key: ServiceAccountKey, nowSeconds: number): Promise<string> {
  const privateKey = await importPKCS8(key.private_key, "RS256");
  return new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", kid: key.private_key_id, typ: "JWT" })
    .setIssuer(key.client_email)
    .setSubject(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(privateKey);
}

export async function accessToken(
  key: ServiceAccountKey,
  cache: TokenCache,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<CachedToken & { cached: boolean }> {
  const cached = await cache.get();
  if (cached && cached.expires_at - REFRESH_MARGIN_MS > now) return { ...cached, cached: true };
  const assertion = await signAssertion(key, Math.floor(now / 1000));
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("token exchange returned no access_token");
  const token = { token: body.access_token, expires_at: now + (body.expires_in ?? 3600) * 1000 };
  await cache.set(token);
  return { ...token, cached: false };
}
