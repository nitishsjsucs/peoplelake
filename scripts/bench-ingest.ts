// npm run bench:ingest [-- --iterations 300 --fresh 9 --sizes 25,50,100,200,500 --out <file>]
//
// CPU per ingest request at several batch sizes (SPEC 29.4.2), as a proxy for the Workers Free plan's
// 10 ms CPU limit per request. It runs the Worker's own code path on full-profile envelopes: JSON parse,
// zod batch parse (the Worker's element schemas in a batch that also admits sizes above the 50-event
// limit), normalization with SHA-256 (node:crypto, as in the Worker), RawRecord parse and NDJSON, with
// zod in jitless mode as in workerd, timing each request with process.cpuUsage(). Warm numbers come from `--iterations`
// requests per size and source in one process after 30 unmeasured warm-up requests; "first request"
// numbers come from `--fresh` new processes per size and source, without and with the module-scope
// prewarm the Worker runs at startup (src/worker/ingest/prewarm-core.ts). It also times the other paths
// bound by 10 ms of CPU (`OTHER_PATHS`: the per-request config parse, the Access JWT verification, a full
// 200-run page, the metrics artifact hash at its cap, the dispatch assertion). It does not time Hono
// routing or the Durable Object RPC (they need the Worker's bindings, so workerd). It reports and never
// gates CI: Node on this machine is not workerd on Cloudflare's CPUs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

z.config({ jitless: true });

const SOURCES = ["hris", "ats", "talent"] as const;
type Source = (typeof SOURCES)[number];
const KEYS: Record<Source, string> = { hris: "events", ats: "records", talent: "items" };
export const FREE_CPU_MS_PER_REQUEST = 10;
const WARMUP = 30;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cpuMs(start: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

function envelopes(root: string, source: Source): string[] {
  const file = join(root, ".data", "generated", "full", `${source}.jsonl`);
  if (!existsSync(file)) {
    const gen = spawnSync("uv", ["run", "--project", "pipeline", "peoplelake", "generate", "--profile", "full", "--out", ".data/generated/full"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, TZ: "UTC" },
    });
    if (gen.status !== 0) throw new Error("could not generate the full profile");
  }
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function body(lines: string[], source: Source, size: number, offset: number): string {
  const start = (offset * size) % Math.max(1, lines.length - size);
  return `{"${KEYS[source]}":[${lines.slice(start, start + size).join(",")}]}`;
}

type BatchSchema = { parse(v: unknown): unknown };
let wide: Record<Source, BatchSchema> | null = null;

/** The Worker's own batch schemas up to the 50-event limit; above it, the same element schemas in batches
 * that admit up to 1,000 events (the bench measures why the limit is 50, so it parses larger batches too). */
async function batchSchema(source: Source, size: number): Promise<BatchSchema> {
  const c = await import("../src/shared/contracts.ts");
  if (size <= c.MAX_BATCH_EVENTS) return { hris: c.HrisBatch, ats: c.AtsBatch, talent: c.TalentBatch }[source];
  if (wide === null) {
    const batch = (key: string, item: z.ZodType) => z.object({ [key]: z.array(item).min(1).max(1000) }).strict();
    wide = { hris: batch("events", c.HrisEvent), ats: batch("records", c.AtsRecord), talent: batch("items", c.TalentItem) };
  }
  return wide[source];
}

/** One ingest request through the Worker's code: returns CPU ms and NDJSON bytes. */
async function request(source: Source, text: string, size: number): Promise<{ ms: number; bytes: number }> {
  const { RawRecord } = await import("../src/shared/contracts.ts");
  const { normalizeBatch, toNdjson } = await import("../src/worker/ingest/normalize.ts");
  const schema = await batchSchema(source, size);
  const t0 = process.cpuUsage();
  const parsed = schema.parse(JSON.parse(text)) as Record<string, unknown>;
  const items = parsed[KEYS[source]] as Parameters<typeof normalizeBatch>[1];
  const records = await normalizeBatch(source, items, { receivedAt: new Date().toISOString(), requestId: "bench", producer: "peoplelake-ingest/bench" });
  for (const r of records) RawRecord.parse(r);
  const ndjson = toNdjson(records);
  return { ms: cpuMs(t0), bytes: Buffer.byteLength(ndjson) };
}

// -- Other paths bound by the 10 ms limit (a request or a Workflow step) --------------------------------

/** Each returns the operation to time, prepared outside the measurement. */
const OTHER_PATHS: Record<string, { detail: string; prepare: () => Promise<() => unknown> }> = {
  "per-request config": {
    detail: "parseConfig on a production-shaped env (role map of 7 people and 5 tokens) after the startup prewarm, on every request",
    prepare: async () => {
      const { parseConfig, prewarmConfig } = await import("../src/worker/config.ts");
      prewarmConfig();
      const emails = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`person${i}@example.com`, ["viewer"]]));
      const tokens = Object.fromEntries(["source:hris", "source:ats", "source:talent", "runner", "operator"].map((r, i) => [`token${i}.access`, r]));
      const env = {
        ENVIRONMENT: "production",
        AUTH_MODE: "access",
        LAKE_MODE: "basin",
        RUNNER_DISPATCH: "cloudrun",
        RUNS_ENABLED: "true",
        ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        ACCESS_AUD: "0123abcd",
        ACCESS_ROLE_MAP: JSON.stringify({ emails, service_tokens: tokens }),
        EVAL_FAULTS_ENABLED: "false",
        GCP_PROJECT: "example-project",
        GCP_DISPATCHER_KEY: "{}",
      };
      return () => parseConfig(env, "peoplelake.example.workers.dev");
    },
  },
  "GET /api/runs?format=full&limit=200": {
    detail: "the full format of 200 run rows (digests, checks, options parsed) serialized as the response body",
    prepare: async () => {
      const { full, MAX_RUNS_PER_PAGE } = await import("../src/worker/api/run-format.ts");
      const digests = JSON.stringify(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`model_${i}`, "a".repeat(64)])));
      const checks = JSON.stringify({ error: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`recon_error_${i}`, 0])), warn: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`recon_warn_${i}`, 0])) });
      const rows = Array.from({ length: MAX_RUNS_PER_PAGE }, (_, i) => ({
        run_id: `r-mgk3x2-${String(i + 1).padStart(6, "0")}`, seq: i + 1, load_seq: 1_790_000_000_000 + i, mode: "incremental", reason: "lake-event", status: "committed",
        requested_at: 1_790_000_000_000 + i, started_at: 1_790_000_000_000 + i, finished_at: 1_790_000_100_000 + i, published_at: 1_790_000_100_000 + i,
        from_snapshot: "8443817436452096001", to_snapshot: "8443817436452096002", rows_inserted: 1700, duplicates_skipped: 0, transform_skipped: 0, transform_skip_reason: null,
        load_attempts: 1, transform_attempts: 1, digests_json: digests, checks_json: checks, metrics_key: `reports/metrics/r-${i}.json`, error: null,
        options_json: null, landing_through: `landing/raw_events/g1/r${String(i).padStart(10, "0")}.ndjson`, steps_used: 8,
      })) as unknown as Parameters<typeof full>[0][];
      return () => JSON.stringify({ runs: rows.map(full), max_per_page: MAX_RUNS_PER_PAGE });
    },
  },
  "PUT metrics artifact at the cap": {
    detail: "SHA-256 of an artifact at MAX_ARTIFACT_BYTES (the PUT checks it; the Workflow's verify step hashes it again)",
    prepare: async () => {
      const { sha256Hex } = await import("../src/worker/ingest/canonical-json.ts");
      const { MAX_ARTIFACT_BYTES } = await import("../src/shared/free-budget.ts");
      const text = "x".repeat(MAX_ARTIFACT_BYTES);
      return () => sha256Hex(text);
    },
  },
  "Access JWT verification (RS256)": {
    detail:
      "verifyAccessJwt on every request: RS256 signature, iss, aud and exp against a JWKS set (the dev key source; production fetches the team's JWKS, which is I/O, and imports the same RSA key); the first call includes the key import",
    prepare: async () => {
      const { exportJWK, generateKeyPair, SignJWT } = await import("jose");
      const { verifyAccessJwt } = await import("../src/worker/auth/access.ts");
      const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: "bench", alg: "RS256", use: "sig" };
      const teamDomain = "https://example.cloudflareaccess.com";
      const aud = "0123abcd";
      const token = await new SignJWT({ email: "person0@example.com", type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "bench" })
        .setIssuer(teamDomain)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      const config = { authMode: "dev", devAccessJwks: JSON.stringify({ keys: [jwk] }), access: { teamDomain, aud } } as unknown as Parameters<typeof verifyAccessJwt>[1];
      return () => verifyAccessJwt(token, config);
    },
  },
  "dispatch assertion (RS256)": {
    detail: "signAssertion: import the dispatcher's PKCS8 key and sign the JWT bearer assertion (the dispatch step, once a token expires)",
    prepare: async () => {
      const { generateKeyPair, exportPKCS8 } = await import("jose");
      const { signAssertion } = await import("../src/worker/orchestration/gcp-token.ts");
      const { privateKey } = await generateKeyPair("RS256", { extractable: true });
      const key = { client_email: "peoplelake-dispatcher@p.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey), private_key_id: "k1" };
      return () => signAssertion(key, Math.floor(Date.now() / 1000));
    },
  },
};

async function timeOnce(op: () => unknown): Promise<number> {
  const t0 = process.cpuUsage();
  await op();
  return cpuMs(t0);
}

async function otherChild(name: string): Promise<void> {
  crypto.randomUUID();
  const op = await (OTHER_PATHS[name] ?? { prepare: async () => () => undefined }).prepare();
  process.stdout.write(`${JSON.stringify({ ms: await timeOnce(op) })}\n`);
}

async function otherPaths(root: string, iterations: number, freshRuns: number) {
  const out = [];
  for (const [name, probe] of Object.entries(OTHER_PATHS)) {
    const op = await probe.prepare();
    for (let i = 0; i < WARMUP; i++) await op();
    const ms: number[] = [];
    for (let i = 0; i < iterations; i++) ms.push(await timeOnce(op));
    const first = Array.from({ length: freshRuns }, () => {
      const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--other", name], { cwd: root, encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
      if (res.status !== 0) throw new Error(`child failed: ${res.stderr}`);
      return (JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}") as { ms: number }).ms;
    });
    out.push({ path: name, detail: probe.detail, warm_p50_ms: round(percentile(ms, 50)), warm_p99_ms: round(percentile(ms, 99)), first_call_fresh_ms: range(first) });
    console.error(`bench-ingest: ${name}: warm p99 ${round(percentile(ms, 99))} ms`);
  }
  return out;
}

async function child(): Promise<void> {
  const source = arg("--child") as Source;
  const size = Number(arg("--size"));
  // The request body comes on stdin, so the fresh process never holds the 30 MB profile (no GC noise).
  const text = readFileSync(0, "utf8");
  // Node loads its WebCrypto implementation (JavaScript modules behind globalThis.crypto, which the Worker
  // uses for crypto.randomUUID) on first use, CPU that workerd, whose crypto is built in, never spends;
  // load it before timing in every fresh process.
  crypto.randomUUID();
  if (process.argv.includes("--prewarm")) {
    // The Worker's prewarm function on the same contract fixtures it imports (src/worker/ingest/prewarm.ts).
    const { prewarmSchemas } = await import("../src/worker/ingest/prewarm-core.ts");
    const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "contracts", "fixtures", `${name}.valid.json`), "utf8")) as never;
    prewarmSchemas({ hris: fixture("source-hris"), ats: fixture("source-ats"), talent: fixture("source-talent"), rawRecord: fixture("raw-record") });
  }
  const { ms } = await request(source, text, size);
  process.stdout.write(`${JSON.stringify({ ms })}\n`);
}

function fresh(root: string, source: Source, size: number, text: string, prewarmFirst: boolean): number {
  const res = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child", source, "--size", String(size), ...(prewarmFirst ? ["--prewarm"] : [])],
    { cwd: root, encoding: "utf8", input: text, env: { ...process.env, TZ: "UTC" }, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`child failed: ${res.stderr}`);
  return (JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}") as { ms: number }).ms;
}

const range = (xs: number[]): [number, number] => [round(Math.min(...xs)), round(Math.max(...xs))];

async function main(): Promise<void> {
  const root = process.cwd();
  const iterations = Number(arg("--iterations") ?? "300");
  const freshRuns = Number(arg("--fresh") ?? "9");
  const sizes = (arg("--sizes") ?? "25,50,100,200,500").split(",").map(Number);
  const lines = Object.fromEntries(SOURCES.map((s) => [s, envelopes(root, s)])) as Record<Source, string[]>;
  const rows = [];
  for (const size of sizes) {
    const perSource: Record<string, unknown> = {};
    const warmP50: number[] = [];
    const warmP99: number[] = [];
    const firstFresh: number[] = [];
    const firstPrewarm: number[] = [];
    const bytes: number[] = [];
    for (const source of SOURCES) {
      const ms: number[] = [];
      let lastBytes = 0;
      // Warm-up requests (not measured): the "warm" numbers describe an isolate that has served requests.
      for (let i = 0; i < WARMUP; i++) await request(source, body(lines[source], source, size, iterations + i), size);
      for (let i = 0; i < iterations; i++) {
        const r = await request(source, body(lines[source], source, size, i), size);
        ms.push(r.ms);
        lastBytes = r.bytes;
      }
      const cold = Array.from({ length: freshRuns }, (_, i) => fresh(root, source, size, body(lines[source], source, size, i), false));
      const warmed = Array.from({ length: freshRuns }, (_, i) => fresh(root, source, size, body(lines[source], source, size, i), true));
      perSource[source] = {
        warm_p50_ms: round(percentile(ms, 50)),
        warm_p99_ms: round(percentile(ms, 99)),
        first_request_fresh_ms: cold.map((x) => round(x)),
        first_request_after_prewarm_ms: warmed.map((x) => round(x)),
        ndjson_bytes: lastBytes,
      };
      warmP50.push(percentile(ms, 50));
      warmP99.push(percentile(ms, 99));
      firstFresh.push(...cold);
      firstPrewarm.push(...warmed);
      bytes.push(lastBytes);
      console.error(`bench-ingest: ${size} events, ${source}: warm p99 ${round(percentile(ms, 99))} ms`);
    }
    rows.push({
      events: size,
      warm_p50_ms: range(warmP50),
      warm_p99_ms: range(warmP99),
      first_request_fresh_ms: range(firstFresh),
      first_request_after_prewarm_ms: range(firstPrewarm),
      ndjson_bytes: range(bytes).map((b) => Math.round(b)),
      within_free_cpu_limit_at_p99: Math.max(...warmP99) < FREE_CPU_MS_PER_REQUEST,
      sources: perSource,
    });
  }
  const date = new Date().toISOString().slice(0, 10);
  const report = {
    kind: "ingest-cpu",
    command: `npm run bench:ingest${process.argv.slice(2).length ? ` -- ${process.argv.slice(2).join(" ")}` : ""}`,
    date,
    method:
      "Worker code path in Node (JSON parse, zod batch parse, normalization with SHA-256, RawRecord parse, NDJSON) on full-profile envelopes, zod jitless, process.cpuUsage() per request, Node's WebCrypto module (globalThis.crypto) loaded before timing in fresh processes (workerd's is built in); a proxy for workerd CPU time",
    runtime: `node ${process.version}`,
    machine: `${platform()} ${arch()} ${cpus()[0]?.model ?? ""}`.trim(),
    load_average_1m: round(loadavg()[0] ?? 0),
    warmup_requests_per_size_and_source: WARMUP,
    iterations_per_size_and_source: iterations,
    fresh_processes_per_size_and_source: freshRuns,
    free_cpu_limit_ms: FREE_CPU_MS_PER_REQUEST,
    batch_limit: (await import("../src/shared/contracts.ts")).MAX_BATCH_EVENTS,
    sizes: rows,
    other_paths: await otherPaths(root, iterations, freshRuns),
  };
  const out = arg("--out") ?? join(root, "evals", "results", `ingest-cpu-${date}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`bench-ingest: wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (process.argv.includes("--other") ? otherChild(arg("--other") ?? "") : process.argv.includes("--child") ? child() : main()).catch((err: unknown) => {
    console.error(`bench-ingest: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
