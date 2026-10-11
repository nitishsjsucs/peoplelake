import { api, type Freshness, type RunFull, type Status } from "../api.ts";
import { Badge, Load, Stat } from "../components/Status.tsx";
import { duration, runOutcome, seconds, share, timestamp } from "../format.ts";
import { useApi } from "../useApi.ts";

export function Overview() {
  const [freshness] = useApi<Freshness>(() => api.freshness("24h"));
  const [status] = useApi<Status>(() => api.status());
  const [runs] = useApi<{ runs: RunFull[] }>(() => api.runs(10));
  return (
    <section aria-labelledby="overview-title">
      <h2 id="overview-title">Overview</h2>
      <h3>Freshness, last 24 hours</h3>
      <Load value={freshness}>
        {(f) => (
          <>
            <div className="stats">
              <Stat label="p50" value={seconds(f.overall.p50_s)} />
              <Stat label="p95" value={seconds(f.overall.p95_s)} note="target 15 min" />
              <Stat label="Within 15 min" value={share(f.overall.share_within_15m)} />
              <Stat label="Events published" value={f.overall.events.toLocaleString("en-US")} />
              <Stat label="Events waiting" value={f.overall.pending_events.toLocaleString("en-US")} />
            </div>
            <p className="muted small">Method: {f.method}.</p>
          </>
        )}
      </Load>
      <h3>Pipeline state</h3>
      <Load value={status}>
        {(s) => (
          <dl className="facts">
            <dt>Active run</dt>
            <dd>{s.active_run_id ?? "none"}</dd>
            <dt>Pending run</dt>
            <dd>{s.pending_mode ?? "none"}</dd>
            <dt>Lake watermark (snapshot)</dt>
            <dd className="mono">{s.watermark ?? "none"}</dd>
            <dt>Last ingest</dt>
            <dd>{s.last_ingest_at ? timestamp(Number(s.last_ingest_at)) : "never"}</dd>
            <dt>Runner last seen</dt>
            <dd>{s.runner_last_seen_at ? timestamp(Number(s.runner_last_seen_at)) : "never"}</dd>
          </dl>
        )}
      </Load>
      <h3>Latest runs</h3>
      <Load value={runs}>
        {({ runs: rows }) =>
          rows.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Outcome</th>
                    <th>Reason</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th className="num">Rows loaded</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.run_id}>
                      <td className="mono">
                        <a href={`#/runs/${r.run_id}`}>{r.run_id}</a>
                      </td>
                      <td>
                        <Badge tone={r.status === "committed" ? "good" : r.status === "failed" ? "bad" : "neutral"}>{runOutcome(r)}</Badge>
                      </td>
                      <td>{r.reason}</td>
                      <td>{timestamp(r.started_at)}</td>
                      <td>{duration(r.started_at, r.finished_at)}</td>
                      <td className="num">{r.rows_inserted ?? "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Load>
    </section>
  );
}
