import { useEffect, useState } from "react";
import { api, getDevToken, type Health, setDevToken } from "./api.ts";
import { ChecksPage } from "./pages/Checks.tsx";
import { Metrics } from "./pages/Metrics.tsx";
import { Overview } from "./pages/Overview.tsx";
import { RunDetail, Runs } from "./pages/Runs.tsx";
import { useApi } from "./useApi.ts";

export type Route = { page: "overview" } | { page: "runs" } | { page: "run"; runId: string } | { page: "metrics" } | { page: "checks" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const [first, second] = path.split("/");
  if (first === "runs" && second) return { page: "run", runId: decodeURIComponent(second) };
  if (first === "runs") return { page: "runs" };
  if (first === "metrics") return { page: "metrics" };
  if (first === "checks") return { page: "checks" };
  return { page: "overview" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(globalThis.location?.hash ?? ""));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(globalThis.location.hash));
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

/** Local only: wrangler dev has no Access in front, so the page sends a pasted dev JWT. */
function DevToken({ onChange }: { onChange: () => void }) {
  const [draft, setDraft] = useState("");
  const saved = getDevToken();
  return (
    <form
      className="devtoken"
      onSubmit={(e) => {
        e.preventDefault();
        setDevToken(draft || null);
        setDraft("");
        onChange();
      }}
    >
      <label>
        Dev token{" "}
        <input
          type="password"
          value={draft}
          placeholder={saved ? "saved for this tab" : "peoplelake auth dev-token operator --ttl 3600"}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Dev token"
        />
      </label>
      <button type="submit">{draft ? "Use token" : saved ? "Forget token" : "Use token"}</button>
    </form>
  );
}

const NAV: { page: Route["page"]; href: string; label: string }[] = [
  { page: "overview", href: "#/", label: "Overview" },
  { page: "runs", href: "#/runs", label: "Runs" },
  { page: "metrics", href: "#/metrics", label: "Metrics" },
  { page: "checks", href: "#/checks", label: "Checks" },
];

export function App() {
  const route = useRoute();
  const [health] = useApi<Health>(() => api.health());
  const [epoch, setEpoch] = useState(0);
  const local = health.state === "ready" && health.data.environment === "local";
  const active = route.page === "run" ? "runs" : route.page;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1>PeopleLake</h1>
          <span className="muted small">
            {health.state === "ready" ? `${health.data.environment} · ${health.data.lake_mode} lake · ${health.data.version}` : "connecting..."}
          </span>
        </div>
        <nav aria-label="Pages">
          {NAV.map((n) => (
            <a key={n.page} href={n.href} aria-current={active === n.page ? "page" : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        {local ? <DevToken onChange={() => setEpoch((e) => e + 1)} /> : null}
      </header>
      <main key={epoch}>
        {route.page === "overview" ? <Overview /> : null}
        {route.page === "runs" ? <Runs /> : null}
        {route.page === "run" ? <RunDetail runId={route.runId} /> : null}
        {route.page === "metrics" ? <Metrics /> : null}
        {route.page === "checks" ? <ChecksPage /> : null}
      </main>
      <footer className="muted small">
        Read-only view of the Worker's <span className="mono">/api/*</span>. Synthetic data. {local ? "Local stand-ins: wrangler dev, SinkRoller, pyiceberg SqlCatalog, DuckDB." : null}
      </footer>
    </div>
  );
}
