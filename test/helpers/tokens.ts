import { env, SELF } from "cloudflare:test";
import { generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

export const ISSUER = "https://peoplelake-dev.local";
export const AUDIENCE = "peoplelake-dev";

export const WHO = {
  operator: { email: "dev@peoplelake.local" },
  viewer: { email: "viewer@peoplelake.local" },
  stranger: { email: "nobody@peoplelake.local" },
  runner: { common_name: "runner.access" },
  hris: { common_name: "src-hris.access" },
  ats: { common_name: "src-ats.access" },
  talent: { common_name: "src-talent.access" },
  unmappedService: { common_name: "unknown.access" },
} as const;
export type Who = keyof typeof WHO;

export interface TokenOptions {
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  foreignKey?: boolean;
}

export async function devToken(who: Who, opts: TokenOptions = {}): Promise<string> {
  const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK;
  let key: CryptoKey | Uint8Array = (await importJWK(jwk, "RS256")) as CryptoKey;
  let kid = jwk.kid ?? "";
  if (opts.foreignKey) {
    key = (await generateKeyPair("RS256")).privateKey;
    kid = "foreign";
  }
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { ...WHO[who] };
  if (!("email" in claims)) claims["sub"] = "";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt(now - 5)
    .setExpirationTime(now + (opts.expiresInSeconds ?? 300))
    .sign(key);
}

export async function call(path: string, who: Who | null, init: RequestInit = {}, opts: TokenOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (who !== null) headers.set("Cf-Access-Jwt-Assertion", await devToken(who, opts));
  return SELF.fetch(`http://127.0.0.1${path}`, { ...init, headers });
}
