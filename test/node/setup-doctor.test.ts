import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Check,
  cloudflareChecks,
  type DoctorDeps,
  doctorCommandAllowed,
  failed,
  format,
  freePlanChecks,
  listsName,
  opsBudgetChecks,
  PROD_FILES_FIX,
  prodFileChecks,
  README_STEP,
  readOnly,
  SETUP_FIX,
  scriptsMissingTz,
  summary,
  versionAtLeast,
} from "../../scripts/doctor.ts";
import { parsePersonaEmails } from "../../scripts/lib/free-plan.ts";
import { bucketListed, buildRoleMap, type Exec, finalRunsEnabled, parseCatalogInfo, queueInfoNames, readEnvFile, redact, SERVICE_TOKENS, Setup, upsertEnv } from "../../scripts/setup-prod.ts";

describe("setup:prod helpers", () => {
  it("never shows secret values in a printed command", () => {
    const line = redact(["wrangler", "basin", "catalog", "snapshot-expiration", "enable", "b", "--token", "s3cr3t-token-value"], ["s3cr3t-token-value"]);
    expect(line).toBe("wrangler basin catalog snapshot-expiration enable b --token <redacted>");
  });

  it("writes env files with mode 600 and replaces keys in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-env-"));
    const path = join(dir, "secrets.env");
    writeFileSync(path, "# comment\nA=1\nB=2\n");
    upsertEnv(path, { B: "3", C: "4" });
    expect(readEnvFile(path)).toEqual({ A: "1", B: "3", C: "4" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("B=2");
  });

  it("enables runs only after a passing bootstrap and honours --runs-enabled false", () => {
    expect(finalRunsEnabled(true, undefined)).toBe(true);
    expect(finalRunsEnabled(false, undefined)).toBe(false);
    expect(finalRunsEnabled(true, "false")).toBe(false);
    expect(finalRunsEnabled(false, "true")).toBe(false);
    expect(() => finalRunsEnabled(true, "no")).toThrow(/true or false/);
  });

  it("reads the Basin Catalog URI and warehouse from wrangler's get and enable output", () => {
    const get = "Getting Basin Catalog status for 'peoplelake-lake'...\n\n\u001b[37mCatalog URI:\u001b[39m  \u001b[90mhttps://catalog.cloudflarestorage.com/acct/peoplelake-lake\u001b[39m\n\u001b[37mWarehouse:\u001b[39m    \u001b[90macct_peoplelake-lake\u001b[39m\n\u001b[37mStatus:\u001b[39m       \u001b[90mactive\u001b[39m";
    expect(parseCatalogInfo(get)).toEqual({ uri: "https://catalog.cloudflarestorage.com/acct/peoplelake-lake", warehouse: "acct_peoplelake-lake" });
    const enable = "Successfully enabled Basin Catalog on bucket 'peoplelake-lake'.\n\nCatalog URI: 'https://catalog.cloudflarestorage.com/acct/peoplelake-lake'\nWarehouse: 'acct_peoplelake-lake'\n\nUse this Catalog URI with Iceberg-compatible query engines";
    expect(parseCatalogInfo(enable)).toEqual({ uri: "https://catalog.cloudflarestorage.com/acct/peoplelake-lake", warehouse: "acct_peoplelake-lake" });
    expect(parseCatalogInfo("Basin Catalog is not enabled for bucket 'peoplelake-lake'.")).toEqual({ uri: "", warehouse: "" });
  });

  it("matches buckets and queues by exact name, with or without colors", () => {
    const list = "Listing buckets...\n\u001b[37mname:\u001b[39m           \u001b[90mpeoplelake-lake-old\u001b[39m\ncreation_date:  x\n\nname:           peoplelake-reports\ncreation_date:  y";
    expect(bucketListed(list, "peoplelake-lake")).toBe(false);
    expect(bucketListed(list, "peoplelake-lake-old")).toBe(true);
    expect(bucketListed(list, "peoplelake-reports")).toBe(true);
    expect(queueInfoNames("Queue Name: peoplelake-lake-events-dlq\nQueue ID: 1", "peoplelake-lake-events")).toBe(false);
    expect(queueInfoNames("Queue Name: peoplelake-lake-events\nQueue ID: 1", "peoplelake-lake-events")).toBe(true);
  });

  it("stops at a create that fails instead of continuing half provisioned, with secrets redacted", () => {
    const root = mkdtempSync(join(tmpdir(), "pl-setup-"));
    mkdirSync(join(root, ".prod"));
    writeFileSync(join(root, ".prod", "secrets.env"), "PL_R2_CATALOG_TOKEN=catalog-token-value\n");
    const calls: string[] = [];
    const exec: Exec = (argv) => {
      const cmd = argv.slice(1).join(" ");
      calls.push(cmd);
      if (cmd.startsWith("queues info peoplelake-lake-events-dlq")) return { ok: true, stdout: "Queue Name: peoplelake-lake-events-dlq", stderr: "" };
      if (cmd.startsWith("queues info")) return { ok: false, stdout: "", stderr: "does not exist" };
      if (cmd.startsWith("r2 bucket list")) return { ok: true, stdout: "", stderr: "" };
      if (cmd.startsWith("r2 bucket create")) return { ok: false, stdout: "", stderr: "Please enable R2 through the Cloudflare Dashboard. [code: 10042]" };
      if (cmd.startsWith("basin catalog snapshot-expiration")) return { ok: false, stdout: "", stderr: "bad token catalog-token-value" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const setup = new Setup(root, false, { exec, http: async () => ({ ok: false, status: 0, json: {} }) });
    expect(() => setup.buckets()).toThrow(/r2 bucket create peoplelake-lake failed: Please enable R2/);
    expect(calls.filter((c) => c.startsWith("r2 bucket create"))).toHaveLength(1);
    setup.queues();
    expect(calls.filter((c) => c.startsWith("queues create"))).toEqual(["queues create peoplelake-lake-events"]);
    expect(() => setup.maintenance()).toThrow(/failed: bad token <redacted>/);
  });

  it("creates one service token per source, the runner and the doctor", () => {
    expect(Object.values(SERVICE_TOKENS).map((t) => t.role).sort()).toEqual(["operator", "runner", "source:ats", "source:hris", "source:talent"]);
  });
});

describe("doctor helpers", () => {
  it("compares versions", () => {
    expect(versionAtLeast("v25.9.0", "22.18.0")).toBe(true);
    expect(versionAtLeast("v22.17.9", "22.18.0")).toBe(false);
    expect(versionAtLeast("22.18.0", "22.18.0")).toBe(true);
  });

  it("flags npm scripts that run node, vitest or uv without TZ=UTC, and the repo's own scripts pass", () => {
    expect(scriptsMissingTz({ a: "vitest run", b: "TZ=UTC vitest run", c: "tsc -p tsconfig.node.json", d: "wrangler types" })).toEqual(["a", "c"]);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(scriptsMissingTz(pkg.scripts)).toEqual([]);
  });

  it("prints the fix only for checks that did not pass", () => {
    expect(format({ name: "x", status: "PASS", fix: "do y" })).toBe("PASS     x");
    expect(format({ name: "x", status: "MISSING", detail: "d", fix: "do y" })).toBe("MISSING  x: d\n         fix: do y");
  });

  it("reports secret names, never values, and loose file modes", () => {
    const root = mkdtempSync(join(tmpdir(), "pl-doc-"));
    const prod = join(root, ".prod");
    mkdirSync(prod);
    writeFileSync(join(prod, "config.env"), "PL_GCP_PROJECT=p\n", { mode: 0o644 });
    writeFileSync(join(prod, "secrets.env"), "PL_CF_SETUP_TOKEN=very-secret-value\n", { mode: 0o600 });
    const lines = prodFileChecks(root).map(format).join("\n");
    expect(lines).toContain("WARN     .prod/config.env mode");
    expect(lines).toContain("PL_R2_CATALOG_TOKEN");
    expect(lines).not.toContain("PL_R2_SINK_TOKEN");
    expect(lines).not.toContain("very-secret-value");
  });
});


describe("setup:prod on the Workers Free plan (SPEC 21.0)", () => {
  function dryRun(): string {
    const root = mkdtempSync(join(tmpdir(), "pl-setup-"));
    mkdirSync(join(root, ".prod"));
    writeFileSync(
      join(root, ".prod", "config.env"),
      [
        "PL_CF_ACCOUNT_ID=00000000000000000000000000000000",
        "PL_WORKERS_SUBDOMAIN=example",
        "PL_ACCESS_TEAM_DOMAIN=https://example.cloudflareaccess.com",
        "PL_OWNER_EMAIL=owner@example.com",
        "PL_PERSONA_EMAILS=owner+hr@example.com:viewer",
        "PL_GCP_PROJECT=example-project",
      ].join("\n"),
    );
    writeFileSync(join(root, ".prod", "secrets.env"), "PL_CF_SETUP_TOKEN=setup-token-value\nPL_R2_CATALOG_TOKEN=catalog-token-value\n");
    const exec: Exec = (argv) => {
      const cmd = argv.join(" ");
      if (cmd.endsWith("--version")) return { ok: true, stdout: cmd.includes("wrangler") ? "4.149.0" : "gcloud 587.0.0", stderr: "" };
      if (cmd.includes("billing projects describe")) return { ok: true, stdout: "True", stderr: "" };
      if (cmd.includes("whoami")) return { ok: true, stdout: "You are logged in", stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    };
    const http = async () => ({ ok: false, status: 404, json: { result: [] } });
    const setup = new Setup(root, true, { exec, http });
    return setup.all(undefined).then(() => setup.log.join("\n")) as unknown as string;
  }

  it("creates nothing that needs Workers Paid, names everything peoplelake and never prints a secret", async () => {
    const log = await dryRun();
    const commands = log.split("\n").filter((l) => /^\s+would (run|call):/.test(l));
    expect(commands.length).toBeGreaterThan(10);
    expect(commands.join("\n")).not.toMatch(/pipelines|notification|compaction/);
    expect(log).not.toContain("PL_R2_SINK_TOKEN");
    expect(log).toContain("lake init --target prod");
    expect(log).toContain("snapshot-expiration enable peoplelake-lake --token <redacted> --older-than-days 7 --retain-last 50");
    expect(log).not.toContain("catalog-token-value");
    expect(log).not.toContain("setup-token-value");
    for (const m of log.matchAll(/would run: npx wrangler (?:r2 bucket|queues) create (\S+)/g)) expect(m[1]).toMatch(/^peoplelake-/);
    for (const name of Object.keys(SERVICE_TOKENS)) expect(name).toMatch(/^peoplelake-/);
    expect(log).toMatch(/would call: POST .*\/access\/service_tokens \{"name":"peoplelake-source-hris"/);
    expect(log).toContain('"email":{"email":"owner+hr@example.com"}');
  });

  it("refuses to run while billing is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pl-setup-"));
    mkdirSync(join(root, ".prod"));
    writeFileSync(join(root, ".prod", "config.env"), "PL_GCP_PROJECT=example-project\n");
    writeFileSync(join(root, ".prod", "secrets.env"), "");
    const exec: Exec = (argv) => ({ ok: true, stdout: argv.join(" ").includes("billing") ? "False" : "", stderr: "" });
    const setup = new Setup(root, false, { exec, http: async () => ({ ok: false, status: 0, json: {} }) });
    await expect(setup.all("cloudflare")).rejects.toThrow(/preflight failed/);
    expect(setup.log.join("\n")).toContain("billing is not enabled on example-project");
  });

  it("maps the owner to viewer and operator, each persona to its roles and each token to one role", () => {
    expect(parsePersonaEmails("a+hr@x.com:viewer, b@x.com:viewer|operator")).toEqual({ "a+hr@x.com": ["viewer"], "b@x.com": ["viewer", "operator"] });
    expect(() => parsePersonaEmails("a@x.com:admin")).toThrow(/unknown role/);
    expect(() => parsePersonaEmails("not-an-email:viewer")).toThrow(/not an email/);
    const map = buildRoleMap("Owner@X.com", "owner+hr@x.com:viewer", { "peoplelake-runner": "runner-id.access" });
    expect(map.emails).toEqual({ "owner@x.com": ["viewer", "operator"], "owner+hr@x.com": ["viewer"] });
    expect(map.service_tokens["runner-id.access"]).toBe("runner");
  });
});

describe("doctor on the Workers Free plan", () => {
  it("fails a config with a pipelines binding and passes the repo's own", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(freePlanChecks(wrangler).map((c) => c.status)).toEqual(["PASS", "PASS"]);
    const paid = wrangler.replace('"name": "peoplelake-local",', '"name": "peoplelake-local", "pipelines": [{ "binding": "RAW_STREAM", "stream": "x" }],');
    expect(freePlanChecks(paid)[0]).toMatchObject({ status: "FAIL" });
  });

  it("prints production's /api/ops/budget against the planning shares", () => {
    const checks = opsBudgetChecks({
      durable_objects: { rows_read_today: 12_000, rows_written_today: 25_000 },
      runs: { automatic_today: 4, automatic_max_per_day: 30, consecutive_failures: 2, failure_backoff_until: Date.parse("2026-10-12T00:10:00Z"), workflow_steps_today: 40 },
      workers_ai: { neurons_today: 34, cap: 1800 },
      bigquery: { bytes_billed: 3_000_000_000, cap_bytes: 275_000_000_000, month: "2026-10" },
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["Durable Object rows written today"]).toMatchObject({ status: "WARN", detail: "25,000 of 20,000 rows (20% of 100,000)" });
    expect(by["Durable Object rows read today"]?.status).toBe("PASS");
    expect(by["failure backoff"]).toMatchObject({ status: "WARN" });
    expect(by["BigQuery bytes billed this month (2026-10)"]?.status).toBe("PASS");
  });
});

describe("doctor: read only, before and after setup", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";

  interface World {
    loggedIn?: boolean;
    r2Enabled?: boolean;
    buckets?: string[];
    catalog?: boolean;
    queues?: string[];
    deployed?: boolean;
    idps?: string[] | "forbidden";
    tokens?: string[];
    gateway?: boolean;
    app?: boolean;
  }

  function fakeDeps(w: World) {
    const commands: string[][] = [];
    const accounts: (string | undefined)[] = [];
    const requests: { method: string; url: string }[] = [];
    const probes: string[] = [];
    const deps: DoctorDeps = {
      exec: (argv, opts) => {
        commands.push(argv);
        accounts.push(opts.env?.["CLOUDFLARE_ACCOUNT_ID"]);
        const cmd = argv.slice(1).join(" ");
        const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
        const fail = (stderr: string) => ({ ok: false, stdout: "", stderr });
        if (cmd.startsWith("whoami")) return w.loggedIn === false ? fail("not authenticated") : ok(JSON.stringify({ loggedIn: true, accounts: [{ id: ACCOUNT }] }));
        if (cmd.startsWith("auth token")) return ok(JSON.stringify({ type: "oauth", token: "oauth-token-value" }));
        if (cmd.startsWith("r2 bucket list")) return w.r2Enabled === false ? fail("Please enable R2 through the Cloudflare Dashboard. [code: 10042]") : ok((w.buckets ?? []).map((b) => `name:           ${b}\ncreation_date:  2026-10-11`).join("\n\n"));
        if (cmd.startsWith("basin catalog get")) return w.catalog ? ok("Catalog URI: https://catalog.example/x\nWarehouse: acct_peoplelake-lake\nStatus: active") : fail("not enabled");
        if (cmd.startsWith("queues info")) {
          const q = argv.at(-1) ?? "";
          return (w.queues ?? []).includes(q) ? ok(`Queue Name: ${q}\nQueue ID: 1\nNumber of Consumers: 1`) : fail(`✘ [ERROR] Queue "${q}" does not exist. To create it, run: wrangler queues create ${q}`);
        }
        if (cmd.startsWith("deployments list")) return w.deployed ? ok("Created: 2026-10-11") : fail("This Worker does not exist on your account. [code: 10007]");
        if (cmd.startsWith("secret list")) return ok(JSON.stringify([{ name: "GCP_DISPATCHER_KEY", type: "secret_text" }]));
        if (argv.includes("lake")) return ok(JSON.stringify({ table: "peoplelake.raw_events", exists: true, landing_cursor: null }));
        return fail("unexpected");
      },
      http: async (method, url) => {
        requests.push({ method, url });
        if (url.endsWith("/workers/subdomain")) return { ok: true, status: 200, json: { result: { subdomain: "example-sub" } } };
        if (url.endsWith("/user/tokens/verify")) return { ok: true, status: 200, json: { result: { status: "active" } } };
        if (url.endsWith("/access/identity_providers")) return w.idps === "forbidden" ? { ok: false, status: 403, json: {} } : { ok: true, status: 200, json: { result: (w.idps ?? []).map((type) => ({ type })) } };
        if (url.endsWith("/access/service_tokens")) return { ok: true, status: 200, json: { result: (w.tokens ?? []).map((name) => ({ name, id: name })) } };
        if (url.includes("/ai-gateway/gateways/")) return w.gateway ? { ok: true, status: 200, json: { result: {} } } : { ok: false, status: 404, json: {} };
        if (url.endsWith("/access/apps")) return { ok: true, status: 200, json: { result: w.app ? [{ name: "peoplelake", aud: "aud-1" }] : [] } };
        return { ok: false, status: 500, json: {} };
      },
      probe: async (url, headers) => {
        probes.push(url);
        if (url.endsWith("/cdn-cgi/access/certs")) return { status: 200, json: { keys: [{ kid: "a" }, { kid: "b" }] } };
        if (url.endsWith("/v1/health")) return { status: 302, json: null };
        if (url.endsWith("/v1/health/auth")) {
          const id = headers?.["CF-Access-Client-Id"] ?? "";
          if (headers?.["CF-Access-Client-Secret"] === "wrong-secret") return { status: 403, json: null };
          const role = Object.values(SERVICE_TOKENS).find((t) => id === `${t.env}-id`)?.role;
          return { status: 200, json: { roles: role ? [role] : [] } };
        }
        if (url.endsWith("/api/ops/lake")) return { status: 200, json: { landing: { landed_through: null } } };
        if (url.endsWith("/api/ops/budget")) return { status: 200, json: {} };
        if (url.endsWith("/api/ops/ai")) return { status: 200, json: { gateway_log_id_present: true } };
        if (url.includes("/api/ops/dispatch")) return { status: 200, json: { ok: true } };
        return { status: 0, json: null };
      },
    };
    return { deps, commands, accounts, requests, probes };
  }

  function root(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "pl-doctor-"));
    mkdirSync(join(dir, ".prod"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, ".prod", name), text, { mode: 0o600 });
    return dir;
  }

  const byName = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

  it("allows only read commands and GET requests", async () => {
    for (const ok of [["/x/node_modules/.bin/wrangler", "whoami", "--json"], ["wrangler", "r2", "bucket", "list"], ["wrangler", "basin", "catalog", "get", "b"], ["uv", "run", "--project", "pipeline", "peoplelake", "prod", "doctor-gcp", "--json"]]) {
      expect(doctorCommandAllowed(ok)).toBe(true);
    }
    for (const no of [
      ["wrangler", "r2", "bucket", "create", "peoplelake-lake"],
      ["wrangler", "queues", "create", "q"],
      ["wrangler", "basin", "catalog", "enable", "b"],
      ["wrangler", "deploy"],
      ["wrangler", "secret", "put", "X"],
      ["uv", "run", "--project", "pipeline", "peoplelake", "prod", "bootstrap-gcp"],
      ["uv", "run", "--project", "pipeline", "peoplelake", "lake", "init", "--target", "prod"],
      ["gcloud", "services", "enable", "run.googleapis.com"],
    ]) {
      expect(doctorCommandAllowed(no)).toBe(false);
    }
    const guarded = readOnly(fakeDeps({}).deps);
    expect(() => guarded.exec(["wrangler", "r2", "bucket", "create", "x"], {})).toThrow(/read-only/);
    expect(() => guarded.http("POST", "https://api.cloudflare.com/client/v4/x", "t")).toThrow(/only sends GET/);
  });

  it("before setup, reports exactly what is missing on the real account, read only", async () => {
    const fake = fakeDeps({ buckets: ["someone-elses-bucket"], queues: ["peoplelake-lake-events-dlq-old"] });
    const checks = await cloudflareChecks(root(), readOnly(fake.deps), { env: {} });
    const by = byName(checks);
    expect(by["wrangler login (OAuth)"]?.status).toBe("PASS");
    expect(by["Cloudflare account"]).toMatchObject({ status: "INFO" });
    expect(by["workers.dev subdomain"]).toMatchObject({ status: "PASS", detail: "example-sub.workers.dev" });
    expect(by["R2 bucket peoplelake-lake"]?.status).toBe("MISSING");
    expect(by["R2 bucket peoplelake-reports"]?.status).toBe("MISSING");
    expect(by["Basin Catalog on peoplelake-lake"]).toMatchObject({ status: "MISSING", detail: "the bucket does not exist yet" });
    expect(by["Iceberg table peoplelake.raw_events"]?.detail).toContain("PL_R2_CATALOG_TOKEN");
    expect(by["queue peoplelake-lake-events"]?.status).toBe("MISSING");
    expect(by["queue peoplelake-lake-events-dlq"]?.status).toBe("MISSING");
    expect(by["Zero Trust team domain"]).toMatchObject({ status: "MISSING", detail: "PL_ACCESS_TEAM_DOMAIN is not set" });
    expect(by["One-time PIN login method"]).toMatchObject({ status: "UNKNOWN", detail: "not checkable without PL_CF_SETUP_TOKEN" });
    expect(by["One-time PIN login method"]?.fix).toContain(`step ${README_STEP.onetimePin}`);
    expect(by["Access service tokens, AI Gateway and the Access application"]?.status).toBe("UNKNOWN");
    expect(by["Worker peoplelake deployed"]?.status).toBe("MISSING");
    expect(checks.at(-1)?.status).toBe("INFO");
    expect(checks.filter((c) => c.status === "UNKNOWN").map((c) => c.name)).toEqual(["One-time PIN login method", "Access service tokens, AI Gateway and the Access application"]);
    for (const argv of fake.commands) expect(doctorCommandAllowed(argv)).toBe(true);
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true);
    const printed = checks.map(format).join("\n");
    expect(printed).not.toContain("oauth-token-value");
    expect(printed).not.toContain(ACCOUNT);
    // every wrangler call after the login is pinned to the account it checks
    expect(fake.accounts.slice(1).every((a) => a === ACCOUNT)).toBe(true);
    expect(fake.accounts.length).toBeGreaterThan(4);
  });

  it("names R2 itself when it is not enabled", async () => {
    const checks = await cloudflareChecks(root(), readOnly(fakeDeps({ r2Enabled: false }).deps), { env: {} });
    expect(byName(checks)["R2"]).toMatchObject({ status: "MISSING", detail: "R2 is not enabled on the account" });
  });

  it("stops at the login when wrangler is not logged in", async () => {
    const checks = await cloudflareChecks(root(), readOnly(fakeDeps({ loggedIn: false }).deps), { env: {} });
    expect(checks).toEqual([{ name: "wrangler login", status: "MISSING", fix: "npx wrangler login" }]);
  });

  it("with the setup token, checks One-time PIN, service tokens, AI Gateway and the Access application", async () => {
    const dir = root({ "secrets.env": "PL_CF_SETUP_TOKEN=setup-token-value\n" });
    const env = { PL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", PL_CF_ACCOUNT_ID: ACCOUNT };
    const none = byName(await cloudflareChecks(dir, readOnly(fakeDeps({ idps: [] }).deps), { env }));
    expect(none["Zero Trust team domain"]).toMatchObject({ status: "PASS", detail: "2 signing keys published" });
    expect(none["Cloudflare account (PL_CF_ACCOUNT_ID) in the wrangler login"]?.status).toBe("PASS");
    expect(none["PL_CF_SETUP_TOKEN active"]?.status).toBe("PASS");
    expect(none["One-time PIN login method"]).toMatchObject({ status: "MISSING" });
    expect(none["One-time PIN login method"]?.fix).toContain(`step ${README_STEP.onetimePin}`);
    expect(none["Access service tokens"]?.detail).toBe(Object.keys(SERVICE_TOKENS).join(", "));
    expect(none["AI Gateway peoplelake"]?.status).toBe("MISSING");
    expect(none["Access application peoplelake"]?.status).toBe("MISSING");
    const forbidden = byName(await cloudflareChecks(dir, readOnly(fakeDeps({ idps: "forbidden" }).deps), { env }));
    expect(forbidden["One-time PIN login method"]?.status).toBe("WARN");
    const otp = byName(await cloudflareChecks(dir, readOnly(fakeDeps({ idps: ["onetimepin"] }).deps), { env }));
    expect(otp["One-time PIN login method"]?.status).toBe("PASS");
  });

  it("after setup, every check passes, live checks included", async () => {
    const tokenSecrets = Object.values(SERVICE_TOKENS).flatMap((t) => [`${t.env}_CLIENT_ID=${t.env}-id`, `${t.env}_CLIENT_SECRET=${t.env}-secret`]);
    const state = JSON.parse(readFileSync("scripts/fixtures/prod-state.example.json", "utf8")) as { account_id: string; access: { aud: string } };
    state.account_id = ACCOUNT;
    state.access.aud = "aud-1";
    const dir = root({
      "config.env": `PL_CF_ACCOUNT_ID=${ACCOUNT}\n`,
      "secrets.env": ["PL_CF_SETUP_TOKEN=setup-token-value", "PL_R2_CATALOG_TOKEN=catalog-token-value", ...tokenSecrets].join("\n"),
      "state.json": JSON.stringify(state),
    });
    const fake = fakeDeps({ buckets: ["peoplelake-lake", "peoplelake-reports"], catalog: true, queues: ["peoplelake-lake-events", "peoplelake-lake-events-dlq"], deployed: true, idps: ["onetimepin"], tokens: Object.keys(SERVICE_TOKENS), gateway: true, app: true });
    const checks = await cloudflareChecks(dir, readOnly(fake.deps), { env: {} });
    expect(checks.filter((c) => c.status !== "PASS").map((c) => `${c.name}: ${c.status}`)).toEqual([]);
    expect(fake.probes).toContain("https://peoplelake.example-sub.workers.dev/api/ops/dispatch");
    expect(failed([...checks, ...prodFileChecks(dir).filter((c) => c.status !== "INFO")])).toBe(false);
  });

  it("matches whole names only and summarizes by fix", () => {
    expect(listsName("| peoplelake-lake-events-dlq | 0 |", "peoplelake-lake-events")).toBe(false);
    expect(listsName("| peoplelake-lake-events | 0 |", "peoplelake-lake-events")).toBe(true);
    const lines = summary([
      { name: "a", status: "PASS" },
      { name: "b", status: "MISSING", fix: "npm run setup:prod (README production setup step 8)" },
      { name: "c", status: "FAIL", fix: "README production setup step 4: link billing" },
      { name: "d", status: "INFO" },
      { name: "e", status: "WARN", fix: "chmod 600" },
      { name: "f", status: "MISSING", fix: "npm run setup:prod (README production setup step 8)" },
    ]);
    expect(lines).toEqual([
      "6 checks: 1 pass, 1 fail, 2 missing, 1 warn, 1 info",
      "Not passing, grouped by fix in README step order:",
      "  README production setup step 4: link billing",
      "    - c (FAIL)",
      "  npm run setup:prod (README production setup step 8)",
      "    - b (MISSING)",
      "    - f (MISSING)",
      "  chmod 600",
      "    - e (WARN)",
    ]);
  });

  it("cites the same README steps and setup fix as doctor-gcp, so the merged summary groups them", () => {
    const py = readFileSync("pipeline/src/peoplelake/prod/doctor_gcp.py", "utf8");
    const pySteps = Object.fromEntries([...(/README_STEP = \{([^}]+)\}/.exec(py)?.[1] ?? "").matchAll(/"(\w+)": (\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(pySteps).toEqual({ billing: README_STEP.billing, quota_project: README_STEP.quotaProject, prod_files: README_STEP.prodFiles, setup: README_STEP.setup, go_live: README_STEP.goLive });
    expect(py).toContain(`SETUP_FIX = f"npm run setup:prod (README production setup step {README_STEP['setup']})"`);
    expect(SETUP_FIX).toBe(`npm run setup:prod (README production setup step ${README_STEP.setup})`);
    expect(py).toContain(`PROD_FILES_FIX = f"README production setup step {README_STEP['prod_files']}: .prod/config.env and .prod/secrets.env"`);
    expect(PROD_FILES_FIX).toBe(`README production setup step ${README_STEP.prodFiles}: .prod/config.env and .prod/secrets.env`);
  });

  it("cites the right README production setup steps", () => {
    const readme = readFileSync("README.md", "utf8");
    const section = readme.split("### Steps only a person can do")[1]?.split("\n### ")[0] ?? "";
    const steps = new Map([...section.matchAll(/^\s*(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2] ?? ""]));
    expect(steps.get(README_STEP.onetimePin)).toContain("One-time PIN");
    expect(steps.get(README_STEP.catalogToken)).toContain("Admin Read & Write");
    expect(steps.get(README_STEP.setupToken)).toContain("peoplelake-setup");
    expect(steps.get(README_STEP.billing)?.toLowerCase()).toContain("billing");
    expect(steps.get(README_STEP.quotaProject)).toContain("set-quota-project");
    expect(steps.get(README_STEP.prodFiles)).toContain(".prod/config.env");
    expect(steps.get(README_STEP.setup)).toContain("setup:prod");
    expect(steps.get(README_STEP.goLive)).toContain("Go live");
  });
});
