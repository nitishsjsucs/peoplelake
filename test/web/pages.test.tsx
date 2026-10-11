import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_TOKEN_KEY } from "../../web/src/api.ts";
import { App } from "../../web/src/App.tsx";
import { DEPARTMENTS } from "../../web/src/format.ts";

type Handler = (path: string) => { status: number; body: unknown } | undefined;

const calls: { path: string; headers: Record<string, string> }[] = [];

function stubApi(environment: "local" | "production", extra: Handler = () => undefined): void {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      const custom = extra(path);
      if (custom) return Response.json(custom.body, { status: custom.status });
      if (path === "/v1/health") return Response.json({ ok: true, version: "0.1.0", environment, lake_mode: environment === "local" ? "local" : "basin" });
      if (path.startsWith("/api/freshness")) {
        return Response.json({
          window: "24h",
          method: "ledger histograms",
          overall: { events: 100000, pending_events: 0, p50_s: 48, p90_s: 74, p95_s: 78, p99_s: 86, max_s: 93, share_within_15m: 1 },
          runs: [],
        });
      }
      if (path === "/api/status") return Response.json({ active_run_id: null, pending_mode: null, last_ingest_at: null, runner_last_seen_at: null, watermark: "123" });
      if (path.startsWith("/api/runs/")) return Response.json({ run: RUNS[0], jobs: JOBS });
      if (path.startsWith("/api/runs")) return Response.json({ runs: RUNS });
      if (path === "/api/metrics/latest") return Response.json(SNAPSHOT);
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
}

const RUNS = [
  {
    run_id: "r-gen-000002",
    seq: 2,
    mode: "incremental",
    reason: "lake-event",
    status: "committed",
    requested_at: 1_000,
    started_at: 2_000,
    finished_at: 24_000,
    published_at: 24_000,
    rows_inserted: 500,
    duplicates_skipped: 3,
    transform_skipped: false,
    load_attempts: 2,
    transform_attempts: 1,
    error: null,
    load_seq: 1_700_000_000_000_002,
    from_snapshot: "11",
    to_snapshot: "12",
    digests: { dim_job: "abcdef0123456789abcdef" },
    checks: { error: { recon_history_contiguity: 0 }, warn: { recon_metrics_vs_oracle: 4, recon_anomalies_open: 0 } },
    metrics_key: "reports/metrics/r-gen-000002.json",
  },
  {
    run_id: "r-gen-000001",
    seq: 1,
    mode: "incremental",
    reason: "manual",
    status: "failed",
    requested_at: 0,
    started_at: 500,
    finished_at: 900,
    published_at: null,
    rows_inserted: null,
    duplicates_skipped: null,
    transform_skipped: false,
    load_attempts: 3,
    transform_attempts: 0,
    error: "load failed after 3 attempts",
    load_seq: 1,
    from_snapshot: null,
    to_snapshot: null,
    digests: null,
    checks: null,
    metrics_key: null,
  },
];

const JOBS = [
  { job_id: "j2", run_id: "r-gen-000002", kind: "load", attempt: 2, status: "succeeded", created_at: 5_000, claimed_at: 6_000, claimed_by: "runner-1", finished_at: 9_000, result: null },
  { job_id: "j1", run_id: "r-gen-000002", kind: "load", attempt: 1, status: "expired", created_at: 2_000, claimed_at: 3_000, claimed_by: "runner-1", finished_at: 4_000, result: { error: "lease expired" } },
];

function month(i: number): string {
  const y = 2023 + Math.floor(i / 12);
  return `${y}-${String((i % 12) + 1).padStart(2, "0")}-01`;
}

const SNAPSHOT = {
  run_id: "r-gen-000002",
  engine: "duckdb",
  profile: "small",
  rows: Array.from({ length: 36 }, (_, i) => i).flatMap((i) =>
    Object.keys(DEPARTMENTS).map((d) => ({
      month: month(i),
      department_id: d,
      headcount: String(d === "ALL" ? 400 + i : 30 + i),
      fte: "10.500000",
      hires: "3",
      rehires: "0",
      departures: "1",
      transfers_in: "0",
      transfers_out: "0",
      offers_extended: "4",
      offers_accepted: "3",
      offers_declined: "1",
      offer_acceptance_rate: i === 0 ? null : "0.750000",
    })),
  ),
};

beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard", () => {
  it("shows freshness and the latest runs on the overview", async () => {
    stubApi("production");
    render(<App />);
    expect(await screen.findByText("78 s")).toBeTruthy();
    expect(screen.getByText("48 s")).toBeTruthy();
    expect(screen.getByText("100.0%")).toBeTruthy();
    const link = await screen.findAllByRole("link", { name: "r-gen-000002" });
    expect(link[0]?.getAttribute("href")).toBe("#/runs/r-gen-000002");
    expect(screen.getByText("committed")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("asks for a dev token only on the local Worker and sends it as the Access header", async () => {
    stubApi("local");
    render(<App />);
    const input = await screen.findByLabelText("Dev token");
    fireEvent.change(input, { target: { value: "dev.jwt.token" } });
    fireEvent.click(screen.getByRole("button", { name: "Use token" }));
    expect(sessionStorage.getItem(DEV_TOKEN_KEY)).toBe("dev.jwt.token");
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/api/") && c.headers["Cf-Access-Jwt-Assertion"] === "dev.jwt.token")).toBe(true));
  });

  it("sends no Access header in production (Access adds it) and hides the token form", async () => {
    stubApi("production");
    render(<App />);
    await screen.findByText("78 s");
    expect(screen.queryByLabelText("Dev token")).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/api/")).every((c) => c.headers["Cf-Access-Jwt-Assertion"] === undefined)).toBe(true);
  });

  it("explains a 401 instead of showing an empty page", async () => {
    stubApi("production", (path) => (path.startsWith("/api/") ? { status: 401, body: { error: "unauthenticated", reason: "missing token" } } : undefined));
    render(<App />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]?.textContent).toContain("Not signed in");
  });

  it("charts and tables one department's 36 months from the committed snapshot", async () => {
    stubApi("production");
    window.location.hash = "#/metrics";
    render(<App />);
    expect(await screen.findByText(/468 rows/)).toBeTruthy();
    const path = document.querySelector("path.chart-line");
    expect(path?.getAttribute("data-points")).toBe("36");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(37);
    expect(within(table).getByText("435")).toBeTruthy(); // ALL headcount in the last month
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "D04" } });
    expect(await within(screen.getByRole("table")).findByText("65")).toBeTruthy(); // D04 headcount in the last month
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "offer_acceptance_rate" } });
    await waitFor(() => expect(document.querySelector("path.chart-line")?.getAttribute("data-points")).toBe("35")); // the null month leaves a gap
  });

  it("says when no metrics are committed yet", async () => {
    stubApi("production", (path) => (path === "/api/metrics/latest" ? { status: 404, body: { error: "no_committed_metrics" } } : undefined));
    window.location.hash = "#/metrics";
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("No committed metrics yet");
  });

  it("lists error and warn check totals per run with the non-zero checks named", async () => {
    stubApi("production");
    window.location.hash = "#/checks";
    render(<App />);
    expect(await screen.findByText("recon_metrics_vs_oracle (warn) 4")).toBeTruthy();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(2); // header plus the one run that recorded checks
  });

  it("shows a run's jobs and attempts in the order they were queued", async () => {
    stubApi("production");
    window.location.hash = "#/runs/r-gen-000002";
    render(<App />);
    expect(await screen.findByText("lease expired")).toBeTruthy();
    const bodyRows = within(screen.getAllByRole("table")[0] as HTMLElement).getAllByRole("row").slice(1);
    expect(bodyRows.map((r) => within(r).getAllByRole("cell")[1]?.textContent)).toEqual(["a1", "a2"]);
    expect(screen.getByText("0 error")).toBeTruthy();
    expect(screen.getByText("4 warn")).toBeTruthy();
  });
});
