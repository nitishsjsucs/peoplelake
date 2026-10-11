// Hono app assembly: config (fail closed) -> public health -> Access JWT verification -> role-gated routes.
import { Hono, type MiddlewareHandler } from "hono";
import { ACCESS_HEADER, AuthError, verifyAccessJwt } from "./auth/access.ts";
import { hasRole, type Principal, principalFromClaims } from "./auth/roles.ts";
import { type AppConfig, ConfigError, parseConfig, type Role } from "./config.ts";
import { VERSION } from "./version.ts";

export type AppEnv = { Bindings: Env; Variables: { config: AppConfig; principal: Principal } };
export type App = Hono<AppEnv>;

export const configMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    c.set("config", parseConfig(c.env as unknown as Record<string, unknown>, new URL(c.req.url).hostname));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`peoplelake config error: ${err.message}`);
      return c.json({ error: "config" }, 500);
    }
    throw err;
  }
  await next();
};

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.get("config");
  try {
    const claims = await verifyAccessJwt(c.req.header(ACCESS_HEADER) ?? null, config);
    const principal = principalFromClaims(claims, config.access.roleMap);
    if (principal === null) return c.json({ error: "unauthenticated", reason: "no identity in token" }, 401);
    c.set("principal", principal);
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: "unauthenticated", reason: err.reason }, 401);
    throw err;
  }
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasRole(c.get("principal"), roles)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

export function createApp(mount: (app: App) => void = () => {}): App {
  const app = new Hono<AppEnv>();
  app.use("*", configMiddleware);
  app.get("/v1/health", (c) => {
    const config = c.get("config");
    return c.json({ ok: true, version: VERSION, environment: config.environment, lake_mode: config.lakeMode });
  });
  app.use("*", authMiddleware);
  app.get("/v1/health/auth", (c) => {
    const p = c.get("principal");
    return c.json({ principal: { kind: p.kind, id: p.id }, roles: p.roles });
  });
  mount(app);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(`peoplelake unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
