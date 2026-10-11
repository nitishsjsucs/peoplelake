// How a queued job reaches a runner (ADR 0002). Locally the runner polls /internal/jobs/claim, so the
// poll dispatcher does nothing. In production the Cloud Run dispatcher starts one execution of the job
// `peoplelake-runner` with an empty body (no overrides): the execution claims whatever job is queued.
import type { AppConfig } from "../config.ts";
import { accessToken, parseServiceAccountKey, type ServiceAccountKey, type TokenCache } from "./gcp-token.ts";

export interface DispatchResult {
  mode: "poll" | "cloudrun";
  ref?: string;
}

export interface RunnerDispatcher {
  dispatch(): Promise<DispatchResult>;
}

export class PollDispatcher implements RunnerDispatcher {
  async dispatch(): Promise<DispatchResult> {
    return { mode: "poll" };
  }
}

export interface CloudRunOptions {
  project: string;
  region: string;
  job: string;
  key: ServiceAccountKey;
  tokens: TokenCache;
  fetch?: typeof fetch;
}

export function cloudRunJobUrl(o: Pick<CloudRunOptions, "project" | "region" | "job">): string {
  return `https://run.googleapis.com/v2/projects/${o.project}/locations/${o.region}/jobs/${o.job}:run`;
}

export class CloudRunDispatcher implements RunnerDispatcher {
  readonly #o: CloudRunOptions;
  constructor(o: CloudRunOptions) {
    this.#o = o;
  }

  async dispatch(): Promise<DispatchResult> {
    const fetchImpl = this.#o.fetch ?? fetch;
    const { token } = await accessToken(this.#o.key, this.#o.tokens, fetchImpl);
    const res = await fetchImpl(cloudRunJobUrl(this.#o), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`Cloud Run jobs.run failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const op = (await res.json()) as { name?: string };
    return { mode: "cloudrun", ...(op.name ? { ref: op.name } : {}) };
  }
}

export function makeDispatcher(config: AppConfig, env: Env, tokens: TokenCache, fetchImpl?: typeof fetch): RunnerDispatcher {
  if (config.runnerDispatch === "poll") return new PollDispatcher();
  if (config.gcp === null) throw new Error("RUNNER_DISPATCH=cloudrun needs GCP_PROJECT");
  const raw = (env as unknown as Record<string, unknown>)["GCP_DISPATCHER_KEY"];
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("RUNNER_DISPATCH=cloudrun needs GCP_DISPATCHER_KEY");
  return new CloudRunDispatcher({ ...config.gcp, key: parseServiceAccountKey(raw), tokens, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
