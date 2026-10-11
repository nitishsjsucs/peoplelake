// The Coordinator's runner-seen window must stay below the Cloud Run runner's idle exit minus one poll,
// or a job enqueued after the runner exits waits for the claim timeout (SPEC 8.1, shouldDispatch).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNNER_IDLE_EXIT_SECONDS, RUNNER_POLL_SECONDS, RUNNER_SEEN_WINDOW_SECONDS_AT_MOST } from "../../src/worker/config.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("runner dispatch window", () => {
  it("the Dockerfile and bootstrap run the runner with the idle exit the Worker assumes", () => {
    expect(read("Dockerfile")).toContain(`"--until-idle", "${RUNNER_IDLE_EXIT_SECONDS}"`);
    expect(read("pipeline/src/peoplelake/prod/bootstrap_gcp.py")).toContain(`--until-idle,${RUNNER_IDLE_EXIT_SECONDS},`);
    expect(read("pipeline/src/peoplelake/cli.py")).toContain(`interval=${RUNNER_POLL_SECONDS}.0`);
  });

  it("the window is below the idle exit minus one poll, in every environment of wrangler.jsonc", () => {
    expect(RUNNER_SEEN_WINDOW_SECONDS_AT_MOST).toBeLessThan(RUNNER_IDLE_EXIT_SECONDS - RUNNER_POLL_SECONDS);
    const values = [...read("wrangler.jsonc").matchAll(/"RUNNER_SEEN_WINDOW_SECONDS": "(\d+)"/g)].map((m) => Number(m[1]));
    expect(values).toHaveLength(2);
    for (const v of values) expect(v).toBeLessThanOrEqual(RUNNER_SEEN_WINDOW_SECONDS_AT_MOST);
  });
});
