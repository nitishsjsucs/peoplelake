// npm run setup:prod -- [--dry-run] [--only cloudflare|gcp|worker] [--runs-enabled false]
//
// Idempotent production provisioning for the Workers Free plan (SPEC 21.0, 29). Reads .prod/config.env and
// .prod/secrets.env, writes .prod/state.json (all mode 600). Every step checks before it creates; nothing
// here needs Workers Paid (no Basin Pipelines, no compaction, no R2 notification rule, no Logpush).
// `--dry-run` runs only the read-only checks and prints every mutating command and API call with secrets
// redacted. Secret values go to files with mode 600 (deploy --secrets-file) or the environment of a child
// process; the one wrangler flag that only accepts a token on the command line (--token) is redacted in
// every printed line. Every Cloudflare name it creates starts with `peoplelake`.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { parsePersonaEmails } from "./lib/free-plan.ts";
import type { ProdState } from "./lib/prod-state.ts";

const API = "https://api.cloudflare.com/client/v4";
export const LAKE_BUCKET = "peoplelake-lake";
export const REPORTS_BUCKET = "peoplelake-reports";
export const QUEUES = ["peoplelake-lake-events", "peoplelake-lake-events-dlq"] as const;
export const GATEWAY = "peoplelake";
export const WORKER = "peoplelake";
export const SERVICE_TOKENS = {
  "peoplelake-source-hris": { env: "PL_CF_HRIS", role: "source:hris" },
  "peoplelake-source-ats": { env: "PL_CF_ATS", role: "source:ats" },
  "peoplelake-source-talent": { env: "PL_CF_TALENT", role: "source:talent" },
  "peoplelake-runner": { env: "PL_CF_RUNNER", role: "runner" },
  // Machine identity for `npm run doctor`, which calls the operator-only /api/ops/* checks.
  "peoplelake-doctor": { env: "PL_CF_DOCTOR", role: "operator" },
} as const;

export const REQUIRED_CONFIG = ["PL_CF_ACCOUNT_ID", "PL_WORKERS_SUBDOMAIN", "PL_ACCESS_TEAM_DOMAIN", "PL_OWNER_EMAIL", "PL_GCP_PROJECT"] as const;
/** One R2 token (Admin Read & Write, for the runner's Basin Catalog commits) and the Cloudflare setup token. */
export const REQUIRED_SECRETS = ["PL_CF_SETUP_TOKEN", "PL_R2_CATALOG_TOKEN"] as const;

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`could not make ${path} private (mode 600)`);
}

export function upsertEnv(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  const kept = lines.filter((l) => !Object.keys(values).some((k) => l.startsWith(`${k}=`)));
  writePrivate(path, `${[...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join("\n")}\n`);
}

/** Runs are enabled only after a passing Google Cloud bootstrap, and `--runs-enabled false` keeps them off. */
export function finalRunsEnabled(gcpBootstrapPassed: boolean, override: string | undefined): boolean {
  if (override !== undefined && override !== "true" && override !== "false") throw new Error("--runs-enabled must be true or false");
  return gcpBootstrapPassed && override !== "false";
}

/**
 * The Catalog URI and Warehouse from `wrangler basin catalog get` (labelled values, gray when colors are on)
 * or `enable` (values in single quotes). Format read in wrangler 4.149.0's source (`basinCatalogGetCommand`,
 * `formatLabelledValues`).
 */
export function parseCatalogInfo(text: string): { uri: string; warehouse: string } {
  const plain = stripVTControlCharacters(text);
  const value = (label: string) => new RegExp(`^\\s*${label}:\\s*'?([^'\\s]+)'?\\s*$`, "im").exec(plain)?.[1] ?? "";
  return { uri: value("Catalog URI"), warehouse: value("Warehouse") };
}

/** True when `wrangler r2 bucket list` output (colors stripped) has a bucket named exactly `name`. */
export function bucketListed(listing: string, name: string): boolean {
  return stripVTControlCharacters(listing)
    .split("\n")
    .some((line) => /^\s*name:\s*(\S+)\s*$/.exec(line)?.[1] === name);
}

/** True when `wrangler queues info <name>` printed exactly that queue (`Queue Name: <name>`). */
export function queueInfoNames(info: string, name: string): boolean {
  return stripVTControlCharacters(info)
    .split("\n")
    .some((line) => /^\s*Queue Name:\s*(\S+)\s*$/.exec(line)?.[1] === name);
}

/** Replace secret values in a command line for printing. */
export function redact(argv: string[], secrets: string[]): string {
  return argv
    .map((a) => (secrets.some((s) => s.length > 0 && a.includes(s)) ? "<redacted>" : a))
    .join(" ");
}

/** The Access role map: the owner (viewer, operator), each persona with its roles, each token's one role. */
export function buildRoleMap(owner: string, personas: string, serviceTokenIds: Record<string, string>): ProdState["role_map"] {
  const emails: Record<string, string[]> = {};
  if (owner) emails[owner.toLowerCase()] = ["viewer", "operator"];
  for (const [email, roles] of Object.entries(parsePersonaEmails(personas))) emails[email] = roles;
  return {
    emails,
    service_tokens: Object.fromEntries(Object.entries(SERVICE_TOKENS).map(([name, meta]) => [serviceTokenIds[name] ?? name, meta.role])),
  };
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Exec = (argv: string[], opts: { env?: Record<string, string>; input?: string }) => RunResult;
export type Http = (method: string, url: string, token: string, body?: unknown) => Promise<{ ok: boolean; status: number; json: any }>;

export const realExec: Exec = (argv, opts) => {
  const res = spawnSync(argv[0] ?? "", argv.slice(1), {
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

export const realHttp: Http = async (method, url, token, body) => {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};

export class Setup {
  readonly root: string;
  readonly prod: string;
  readonly dryRun: boolean;
  readonly exec: Exec;
  readonly http: Http;
  config: Record<string, string>;
  secrets: Record<string, string>;
  state: ProdState;
  readonly log: string[] = [];

  constructor(root: string, dryRun: boolean, deps: { exec?: Exec; http?: Http } = {}) {
    this.root = root;
    this.prod = join(root, ".prod");
    this.dryRun = dryRun;
    this.exec = deps.exec ?? realExec;
    this.http = deps.http ?? realHttp;
    this.config = readEnvFile(join(this.prod, "config.env"));
    this.secrets = readEnvFile(join(this.prod, "secrets.env"));
    const statePath = join(this.prod, "state.json");
    this.state = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf8")) as ProdState)
      : {
          account_id: "",
          workers_subdomain: "",
          access: { team_domain: "", aud: "pending" },
          role_map: { emails: {}, service_tokens: {} },
          catalog: { uri: "", warehouse: "" },
          gcp_project: "",
          runs_enabled: false,
          gcp_bootstrap_passed: false,
        };
  }

  say(msg: string): void {
    console.log(msg);
    this.log.push(msg);
  }

  secretValues(): string[] {
    return Object.values(this.secrets).filter((v) => v.length >= 8);
  }

  saveState(): void {
    if (this.dryRun) return;
    writePrivate(join(this.prod, "state.json"), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  run(argv: string[], opts: { mutating: boolean; env?: Record<string, string>; input?: string }): RunResult {
    const shown = redact(argv, this.secretValues()).replace(join(this.root, "node_modules", ".bin", "wrangler"), "npx wrangler");
    if (opts.mutating && this.dryRun) {
      this.say(`  would run: ${shown}`);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (opts.mutating) this.say(`  run: ${shown}`);
    const res = this.exec(argv, { ...(opts.env ? { env: opts.env } : {}), ...(opts.input !== undefined ? { input: opts.input } : {}) });
    // Every step checks before it creates, so a create that fails is a real failure: stop here instead
    // of continuing with a half-provisioned account.
    if (opts.mutating && !res.ok) {
      const reason = stripVTControlCharacters(`${res.stderr}\n${res.stdout}`).trim().split("\n")[0] ?? "";
      throw new Error(`${shown} failed: ${this.secretValues().reduce((t, v) => t.split(v).join("<redacted>"), reason)}`);
    }
    return res;
  }

  wrangler(args: string[], mutating: boolean, env?: Record<string, string>): RunResult {
    return this.run([join(this.root, "node_modules", ".bin", "wrangler"), ...args], { mutating, ...(env ? { env } : {}) });
  }

  async api(method: string, path: string, token: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
    if (this.dryRun && !token) {
      this.say(`  ${method === "GET" ? "cannot check" : "would call"}: ${method} ${API}${path} (no token yet)`);
      return { ok: false, status: 0, json: { result: null } };
    }
    if (method !== "GET" && this.dryRun) {
      this.say(`  would call: ${method} ${API}${path}${body ? ` ${redact([JSON.stringify(body)], this.secretValues())}` : ""}`);
      return { ok: true, status: 0, json: { result: null } };
    }
    if (method !== "GET") this.say(`  call: ${method} ${API}${path}`);
    return this.http(method, `${API}${path}`, token, body);
  }

  oauthToken(): string {
    const res = this.wrangler(["auth", "token", "--json"], false);
    if (!res.ok && this.dryRun) return "";
    if (!res.ok) throw new Error("wrangler is not logged in: run `npx wrangler login`");
    const parsed = JSON.parse(res.stdout) as { token?: string };
    if (!parsed.token) throw new Error("`wrangler auth token --json` returned no token");
    return parsed.token;
  }

  // 1 -------------------------------------------------------------------------------------------------
  preflight(): void {
    this.say("1. preflight");
    const problems: string[] = [];
    for (const f of ["config.env", "secrets.env"]) {
      const p = join(this.prod, f);
      if (!existsSync(p)) problems.push(`.prod/${f} is missing`);
      else if (!this.dryRun) chmodSync(p, 0o600);
    }
    for (const k of REQUIRED_CONFIG) if (!this.config[k]) problems.push(`${k} missing from .prod/config.env`);
    for (const k of REQUIRED_SECRETS) if (!this.secrets[k]) problems.push(`${k} missing from .prod/secrets.env`);
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(this.config["PL_ACCESS_TEAM_DOMAIN"] ?? "")) {
      problems.push("PL_ACCESS_TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com");
    }
    try {
      parsePersonaEmails(this.config["PL_PERSONA_EMAILS"] ?? "");
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    const version = this.wrangler(["--version"], false).stdout.trim();
    if (!version.includes("4.149.0")) problems.push(`wrangler 4.149.0 expected from node_modules (got ${version || "none"})`);
    const who = this.wrangler(["whoami"], false);
    if (!who.ok || /not authenticated|not logged in/i.test(who.stdout + who.stderr)) {
      problems.push("wrangler is not logged in: run `npx wrangler login`");
    }
    if (!this.run(["gcloud", "--version"], { mutating: false }).ok) problems.push("gcloud is not installed: brew install --cask gcloud-cli");
    const project = this.config["PL_GCP_PROJECT"] ?? "";
    if (project) {
      const billing = this.run(["gcloud", "billing", "projects", "describe", project, "--format=value(billingEnabled)"], { mutating: false });
      if (billing.stdout.trim().toLowerCase() !== "true") {
        problems.push(`billing is not enabled on ${project} (the BigQuery sandbox rejects the loader's MERGE): link an open billing account first`);
      }
    }
    if (problems.length > 0) {
      for (const p of problems) this.say(`  MISSING ${p}`);
      if (!this.dryRun) throw new Error("preflight failed; see README production setup");
    }
    this.state.account_id = this.config["PL_CF_ACCOUNT_ID"] ?? "";
    this.state.gcp_project = project;
    this.state.access.team_domain = this.config["PL_ACCESS_TEAM_DOMAIN"] ?? "";
  }

  // 2 -------------------------------------------------------------------------------------------------
  async subdomain(): Promise<void> {
    this.say("2. workers.dev subdomain (check only)");
    const token = this.oauthToken();
    const got = await this.api("GET", `/accounts/${this.state.account_id}/workers/subdomain`, token);
    const current = got.json?.result?.subdomain as string | undefined;
    const wanted = this.config["PL_WORKERS_SUBDOMAIN"] ?? "";
    if (current) {
      this.state.workers_subdomain = current;
      this.say(`  exists: ${current}.workers.dev`);
      if (wanted && wanted !== current) this.say(`  WARN PL_WORKERS_SUBDOMAIN=${wanted} but the account's subdomain is ${current}; using ${current}`);
      return;
    }
    this.state.workers_subdomain = wanted;
    this.say(`  ${this.dryRun ? "cannot confirm" : "MISSING"} ${wanted}.workers.dev (register it in the dashboard: Workers & Pages, Overview, Subdomain)`);
    if (!this.dryRun) throw new Error("no workers.dev subdomain on the account (Workflows need one)");
  }

  // 3 -------------------------------------------------------------------------------------------------
  buckets(): void {
    this.say("3. R2 buckets");
    const listed = stripVTControlCharacters(this.wrangler(["r2", "bucket", "list"], false).stdout);
    for (const b of [LAKE_BUCKET, REPORTS_BUCKET]) {
      if (bucketListed(listed, b)) this.say(`  exists: ${b}`);
      else this.wrangler(["r2", "bucket", "create", b], true);
    }
  }

  // 4 -------------------------------------------------------------------------------------------------
  catalog(): void {
    this.say("4. Basin Catalog on the lake bucket");
    let info = this.wrangler(["basin", "catalog", "get", LAKE_BUCKET], false);
    if (!info.ok || /not enabled|disabled/i.test(info.stdout + info.stderr)) {
      this.wrangler(["basin", "catalog", "enable", LAKE_BUCKET], true);
      info = this.wrangler(["basin", "catalog", "get", LAKE_BUCKET], false);
    } else this.say(`  exists: catalog on ${LAKE_BUCKET}`);
    const parsed = parseCatalogInfo(`${info.stdout}\n${info.stderr}`);
    const uri = this.config["PL_R2_CATALOG_URI"] || parsed.uri;
    const warehouse = this.config["PL_R2_WAREHOUSE"] || parsed.warehouse;
    if (!uri || !warehouse) {
      this.say("  UNKNOWN catalog URI or warehouse in the wrangler output; set PL_R2_CATALOG_URI and PL_R2_WAREHOUSE in .prod/config.env");
    }
    this.state.catalog.uri = uri;
    this.state.catalog.warehouse = warehouse;
  }

  // 5 -------------------------------------------------------------------------------------------------
  lakeTable(): void {
    this.say("5. Iceberg namespace peoplelake and table raw_events (peoplelake lake init --target prod)");
    const env = {
      PL_R2_CATALOG_URI: this.state.catalog.uri,
      PL_R2_WAREHOUSE: this.state.catalog.warehouse,
      PL_R2_CATALOG_TOKEN: this.secrets["PL_R2_CATALOG_TOKEN"] ?? "",
    };
    const res = this.run(["uv", "run", "--project", "pipeline", "peoplelake", "lake", "init", "--target", "prod"], { mutating: true, env });
    if (!this.dryRun && !res.ok) throw new Error(`lake init failed: ${res.stderr.slice(0, 500)}`);
  }

  // 6 -------------------------------------------------------------------------------------------------
  maintenance(): void {
    this.say("6. Basin Catalog snapshot expiration (free; compaction stays off)");
    const token = this.secrets["PL_R2_CATALOG_TOKEN"] ?? "";
    this.wrangler(["basin", "catalog", "snapshot-expiration", "enable", LAKE_BUCKET, "--token", token, "--older-than-days", "7", "--retain-last", "50"], true);
  }

  // 7 -------------------------------------------------------------------------------------------------
  queues(): void {
    this.say("7. Queues");
    // `queues info` looks the name up directly (`queues list` is paginated).
    for (const q of QUEUES) {
      const info = this.wrangler(["queues", "info", q], false);
      if (info.ok && queueInfoNames(info.stdout, q)) this.say(`  exists: ${q}`);
      else this.wrangler(["queues", "create", q], true);
    }
  }

  // 8 -------------------------------------------------------------------------------------------------
  async serviceTokens(): Promise<Record<string, string>> {
    this.say("8. Access service tokens");
    const token = this.secrets["PL_CF_SETUP_TOKEN"] ?? "";
    const base = `/accounts/${this.state.account_id}/access/service_tokens`;
    const listed = await this.api("GET", base, token);
    const existing = new Map<string, string>(((listed.json?.result ?? []) as { name: string; id: string }[]).map((t) => [t.name, t.id]));
    const ids: Record<string, string> = {};
    for (const [name, meta] of Object.entries(SERVICE_TOKENS)) {
      const idKey = `${meta.env}_CLIENT_ID`;
      const secretKey = `${meta.env}_CLIENT_SECRET`;
      const haveSecret = Boolean(this.secrets[idKey] && this.secrets[secretKey]);
      if (existing.has(name) && haveSecret) {
        this.say(`  exists: ${name}`);
        ids[name] = this.secrets[idKey] ?? "";
        continue;
      }
      const res = existing.has(name)
        ? await this.api("POST", `${base}/${existing.get(name)}/rotate`, token)
        : await this.api("POST", base, token, { name, duration: "8760h" });
      const result = res.json?.result as { client_id?: string; client_secret?: string } | null;
      if (!this.dryRun) {
        if (!result?.client_id || !result.client_secret) throw new Error(`could not create or rotate service token ${name} (HTTP ${res.status})`);
        upsertEnv(join(this.prod, "secrets.env"), { [idKey]: result.client_id, [secretKey]: result.client_secret });
        this.secrets[idKey] = result.client_id;
        this.secrets[secretKey] = result.client_secret;
        ids[name] = result.client_id;
      } else ids[name] = `(${name} client id)`;
    }
    return ids;
  }

  // 9 -------------------------------------------------------------------------------------------------
  async gateway(): Promise<void> {
    this.say("9. AI Gateway (core features; no Logpush, which needs Workers Paid)");
    const token = this.secrets["PL_CF_SETUP_TOKEN"] ?? "";
    const path = `/accounts/${this.state.account_id}/ai-gateway/gateways`;
    const got = await this.api("GET", `${path}/${GATEWAY}`, token);
    if (got.ok) {
      this.say(`  exists: ${GATEWAY}`);
      return;
    }
    await this.api("POST", path, token, {
      id: GATEWAY,
      cache_invalidate_on_update: true,
      cache_ttl: 0,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
    });
  }

  // 10, 13 --------------------------------------------------------------------------------------------
  deploy(secrets: Record<string, string>): void {
    const dir = mkdtempSync(join(tmpdir(), "pl-secrets-"));
    const file = join(dir, "secrets.json");
    const stateFile = join(dir, "state.json");
    try {
      writePrivate(stateFile, JSON.stringify(this.state));
      // The dashboard ships with every deploy as static assets (built locally; nothing is uploaded here).
      const build = this.run(["npm", "run", "build:web"], { mutating: false });
      if (!build.ok && !this.dryRun) throw new Error(`dashboard build failed: ${build.stderr}`);
      const render = this.run(["node", "scripts/render-wrangler.ts", "--state", stateFile], { mutating: false });
      if (!render.ok && !this.dryRun) throw new Error(`render failed: ${render.stderr}`);
      const check = this.run(["node", "scripts/predeploy-check.ts", "--state", stateFile], { mutating: false });
      if (!check.ok) {
        if (!this.dryRun) throw new Error(`predeploy-check refused: ${check.stderr}`);
        this.say(`  predeploy-check would refuse:\n${check.stderr.trim()}`);
      }
      writePrivate(file, JSON.stringify(secrets));
      this.wrangler(["deploy", "-c", "wrangler.production.jsonc", "--env", "production", "--secrets-file", file], true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 11 ------------------------------------------------------------------------------------------------
  async accessApp(serviceTokenIds: Record<string, string>): Promise<void> {
    this.say("11. Access application");
    const token = this.secrets["PL_CF_SETUP_TOKEN"] ?? "";
    const base = `/accounts/${this.state.account_id}/access/apps`;
    const apps = await this.api("GET", base, token);
    let app = ((apps.json?.result ?? []) as { id: string; name: string; aud: string }[]).find((a) => a.name === WORKER);
    if (!app) {
      const tokens = await this.api("GET", `/accounts/${this.state.account_id}/access/service_tokens`, token);
      const byName = new Map<string, string>(((tokens.json?.result ?? []) as { name: string; id: string }[]).map((t) => [t.name, t.id]));
      const people = [this.config["PL_OWNER_EMAIL"] ?? "", ...Object.keys(parsePersonaEmails(this.config["PL_PERSONA_EMAILS"] ?? ""))].filter(Boolean);
      const policies = [
        // One-time PIN sign-in; each person who signs in takes one of the 50 Free seats.
        { name: "people", decision: "allow", include: people.map((email) => ({ email: { email } })) },
        {
          name: "machines",
          decision: "non_identity",
          include: Object.keys(serviceTokenIds).map((n) => ({ service_token: { token_id: byName.get(n) ?? n } })),
        },
      ];
      const host = `${WORKER}.${this.state.workers_subdomain}.workers.dev`;
      const created = await this.api("POST", base, token, {
        type: "self_hosted",
        name: WORKER,
        // The API reference lists `domain` as required for self_hosted; `destinations` supersedes the
        // deprecated `self_hosted_domains`. Both name the same hostname.
        domain: host,
        destinations: [{ type: "public", uri: host }],
        session_duration: "24h",
        policies,
      });
      app = created.json?.result as { id: string; name: string; aud: string } | undefined;
      if (!app && !this.dryRun) throw new Error(`could not create the Access application (HTTP ${created.status})`);
    } else this.say(`  exists: ${app.id}`);
    if (app && !app.aud && !this.dryRun) {
      // Whether the create response carries `aud` is unverified (SPEC 25); the application itself does.
      const got = await this.api("GET", `${base}/${app.id}`, token);
      app.aud = (got.json?.result?.aud as string | undefined) ?? "";
      if (!app.aud) throw new Error(`the Access application ${app.id} has no AUD tag (HTTP ${got.status})`);
    }
    if (app) {
      this.state.access.app_id = app.id;
      this.state.access.aud = app.aud;
    }
  }

  roleMap(serviceTokenIds: Record<string, string>): void {
    this.state.role_map = buildRoleMap(this.config["PL_OWNER_EMAIL"] ?? "", this.config["PL_PERSONA_EMAILS"] ?? "", serviceTokenIds);
  }

  // 12 ------------------------------------------------------------------------------------------------
  bootstrapGcp(): boolean {
    this.say("12. Google Cloud (peoplelake prod bootstrap-gcp)");
    const res = this.run(["uv", "run", "--project", "pipeline", "peoplelake", "prod", "bootstrap-gcp", ...(this.dryRun ? ["--plan"] : [])], { mutating: false });
    if (res.stdout) process.stdout.write(res.stdout);
    if (!res.ok) this.say(`  bootstrap-gcp did not pass:\n${res.stderr.slice(0, 2000)}`);
    const gcp = join(this.prod, "gcp.json");
    return res.ok && existsSync(gcp) && (JSON.parse(readFileSync(gcp, "utf8")) as { passed?: boolean }).passed === true;
  }

  async all(only: string | undefined, runsOverride?: string): Promise<void> {
    this.preflight();
    let ids: Record<string, string> = {};
    if (!only || only === "cloudflare") {
      await this.subdomain();
      this.buckets();
      this.catalog();
      this.lakeTable();
      this.maintenance();
      this.queues();
      ids = await this.serviceTokens();
      await this.gateway();
      this.saveState();
      if (!this.state.access.app_id) {
        this.say("10. first deploy (fail closed: ACCESS_AUD=pending, RUNS_ENABLED=false, no secrets)");
        this.state.runs_enabled = false;
        this.state.access.aud = "pending";
        this.roleMap(ids);
        this.saveState();
        this.deploy({});
      }
      await this.accessApp(ids);
      this.saveState();
    }
    if (!only || only === "gcp") {
      this.state.gcp_bootstrap_passed = this.bootstrapGcp();
      this.saveState();
    }
    if (!only || only === "worker") {
      this.say("13. final deploy");
      if (Object.keys(ids).length === 0) {
        for (const [name, meta] of Object.entries(SERVICE_TOKENS)) ids[name] = this.secrets[`${meta.env}_CLIENT_ID`] ?? name;
      }
      this.roleMap(ids);
      this.state.runs_enabled = finalRunsEnabled(this.state.gcp_bootstrap_passed, runsOverride);
      this.saveState();
      const key = join(this.prod, "gcp-dispatcher-key.json");
      const secrets: Record<string, string> = {};
      if (existsSync(key)) secrets["GCP_DISPATCHER_KEY"] = readFileSync(key, "utf8");
      this.deploy(secrets);
      this.say(`  RUNS_ENABLED=${this.state.runs_enabled}`);
    }
    this.say("14. next: npm run doctor -- --quick && npm run budget -- --check");
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const setup = new Setup(process.cwd(), process.argv.includes("--dry-run"));
  const only = arg("--only");
  if (only && !["cloudflare", "gcp", "worker"].includes(only)) {
    console.error("--only must be cloudflare, gcp or worker");
    process.exit(2);
  }
  setup.all(only, arg("--runs-enabled")).catch((err: unknown) => {
    console.error(`setup:prod: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
