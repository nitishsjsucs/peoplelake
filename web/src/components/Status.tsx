import type { ReactNode } from "react";
import type { Loadable } from "../useApi.ts";

/** Renders loading and error states with a fix the person can act on; children render when ready. */
export function Load<T>({ value, children, empty }: { value: Loadable<T>; children: (data: T) => ReactNode; empty?: Record<number, string> }) {
  if (value.state === "loading") return <p className="muted" role="status">Loading...</p>;
  if (value.state === "error") {
    const hint =
      value.status !== null && empty?.[value.status]
        ? empty[value.status]
        : value.status === 401
          ? "Not signed in. In production, reload the page to sign in through Cloudflare Access. Locally, paste a dev token above."
          : value.status === 403
            ? "Signed in, but this identity has no viewer role (ACCESS_ROLE_MAP)."
            : `The Worker answered ${value.status ?? "nothing"}: ${value.message}`;
    return (
      <p className="notice" role="alert">
        {hint}
      </p>
    );
  }
  return <>{children(value.data)}</>;
}

export function Badge({ tone, children }: { tone: "good" | "bad" | "warn" | "neutral"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}
