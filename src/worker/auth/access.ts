// Verify the Cloudflare Access JWT on every request (ADR 0006): RS256, iss, aud and exp with jose.
// Production fetches the team JWKS (remote set handles kid rotation); local and CI verify dev tokens
// signed by locally generated keys with the same code. The CF_Authorization cookie is never read.
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AppConfig } from "../config.ts";

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

export class AuthError extends Error {
  override name = "AuthError";
  readonly reason: "missing" | "invalid" | "expired";
  constructor(reason: "missing" | "invalid" | "expired", message: string) {
    super(message);
    this.reason = reason;
  }
}

const remoteSets = new Map<string, JWTVerifyGetKey>();
let localSet: { source: string; keys: JWTVerifyGetKey } | null = null;

export function keySet(config: AppConfig): JWTVerifyGetKey {
  if (config.authMode === "dev") {
    const source = config.devAccessJwks ?? "";
    if (localSet === null || localSet.source !== source) {
      localSet = { source, keys: createLocalJWKSet(JSON.parse(source)) };
    }
    return localSet.keys;
  }
  const url = `${config.access.teamDomain}/cdn-cgi/access/certs`;
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    remoteSets.set(url, set);
  }
  return set;
}

export async function verifyAccessJwt(token: string | null, config: AppConfig): Promise<JWTPayload> {
  if (!token) throw new AuthError("missing", "missing Access token");
  try {
    const { payload } = await jwtVerify(token, keySet(config), {
      issuer: config.access.teamDomain,
      audience: config.access.aud,
      algorithms: ["RS256"],
    });
    return payload;
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new AuthError("expired", "token expired");
    throw new AuthError("invalid", err instanceof Error ? err.message : "invalid token");
  }
}
