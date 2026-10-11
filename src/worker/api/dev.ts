// Local-only routes (mounted only when ENVIRONMENT=local; 404 otherwise): force a landing roll for the
// eval driver and install eval faults.
import { z } from "zod";
import { FaultSpec } from "../../shared/contracts.ts";
import type { App } from "../app.ts";
import { requireRole } from "../app.ts";
import { landingRollerStub } from "../lake/landing-roller.ts";
import { coordinatorStub } from "../orchestration/coordinator.ts";

export function mountDevRoutes(app: App): void {
  app.post("/internal/dev/landing/flush", requireRole("operator"), async (c) => {
    return c.json(await landingRollerStub(c.env).flush());
  });

  app.post("/internal/dev/faults", requireRole("operator"), async (c) => {
    if (!c.get("config").evalFaultsEnabled) return c.json({ error: "faults_disabled" }, 403);
    const parsed = z.object({ faults: z.array(FaultSpec) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_faults", issues: parsed.error.issues.slice(0, 20) }, 422);
    return c.json(await coordinatorStub(c.env).installFaults(parsed.data.faults));
  });
}
