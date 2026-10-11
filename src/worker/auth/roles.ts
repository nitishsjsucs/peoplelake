// Principals and roles (SPEC 12). Service-token JWTs carry the token's Client ID in `common_name` and an
// empty `sub`; human JWTs carry `email`. ACCESS_ROLE_MAP maps emails to viewer/operator and Client IDs to
// exactly one of runner, source:hris, source:ats, source:talent.
import type { JWTPayload } from "jose";
import type { Role, RoleMap } from "../config.ts";

export interface Principal {
  readonly kind: "user" | "service";
  readonly id: string;
  readonly roles: readonly Role[];
}

export function principalFromClaims(claims: JWTPayload, roleMap: RoleMap): Principal | null {
  const commonName = typeof claims["common_name"] === "string" ? claims["common_name"] : "";
  const email = typeof claims["email"] === "string" ? claims["email"] : "";
  if (commonName) {
    const role = roleMap.service_tokens[commonName];
    return { kind: "service", id: commonName, roles: role ? [role] : [] };
  }
  if (email) {
    return { kind: "user", id: email, roles: roleMap.emails[email.toLowerCase()] ?? roleMap.emails[email] ?? [] };
  }
  return null;
}

export function hasRole(principal: Principal, allowed: readonly Role[]): boolean {
  return principal.roles.some((r) => allowed.includes(r));
}
