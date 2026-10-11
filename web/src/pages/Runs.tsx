import { api, type Job, type RunFull } from "../api.ts";
import { Badge, Load } from "../components/Status.tsx";
import { checkTotals, duration, runOutcome, timestamp } from "../format.ts";
import { useApi } from "../useApi.ts";

function outcomeTone(status: string): "good" | "bad" | "warn" | "neutral" {
  if (status === "committed" || status === "succeeded") return "good";
  if (status === "failed") return "bad";
  if (status === "expired") return "warn";
  return "neutral";
}

export function Runs() {
  const [runs] = useApi<{ runs: RunFull[] }>(() => api.runs(50));
  return (
    <section aria-labelledby="runs-title">
      <h2 id="runs-title">Runs</h2>
      <p className="muted small">The 50 most recent warehouse runs from the Coordinator ledger. Open a run for its jobs and attempts.</p>
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
                    <th>Mode</th>
                    <th>Outcome</th>
                    <th>Reason</th>
                    <th className="num">Load attempts</th>
                    <th className="num">Transform attempts</th>
                    <th className="num">Rows loaded</th>
                    <th className="num">Duplicates skipped</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.run_id}>
                      <td className="mono">
                        <a href={`#/runs/${r.run_id}`}>{r.run_id}</a>
                      </td>
                      <td>{r.mode}</td>
                      <td>
                        <Badge tone={outcomeTone(r.status)}>{runOutcome(r)}</Badge>
                      </td>
                      <td>{r.reason}</td>
                      <td className="num">{r.load_attempts}</td>
                      <td className="num">{r.transform_attempts}</td>
                      <td className="num">{r.rows_inserted ?? "n/a"}</td>
                      <td className="num">{r.duplicates_skipped ?? "n/a"}</td>
                      <td>{duration(r.started_at, r.finished_at)}</td>
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

export function RunDetail({ runId }: { runId: string }) {
  const [detail] = useApi<{ run: RunFull; jobs: Job[] }>(() => api.run(runId), [runId]);
  return (
    <section aria-labelledby="run-title">
      <p>
        <a href="#/runs">All runs</a>
      </p>
      <h2 id="run-title" className="mono">
        {runId}
      </h2>
      <Load value={detail} empty={{ 404: "No run with this id in the ledger." }}>
        {({ run, jobs }) => {
          const totals = checkTotals(run.checks);
          return (
            <>
              <dl className="facts">
                <dt>Outcome</dt>
                <dd>
                  <Badge tone={outcomeTone(run.status)}>{runOutcome(run)}</Badge>
                  {run.error ? <span className="error-text"> {run.error}</span> : null}
                </dd>
                <dt>Mode and reason</dt>
                <dd>
                  {run.mode}, {run.reason}
                </dd>
                <dt>Requested, started, finished</dt>
                <dd>
                  {timestamp(run.requested_at)}, {timestamp(run.started_at)}, {timestamp(run.finished_at)}
                </dd>
                <dt>Lake snapshots</dt>
                <dd className="mono">
                  {run.from_snapshot ?? "start"} to {run.to_snapshot ?? "n/a"}
                </dd>
                <dt>Load sequence</dt>
                <dd className="mono">{run.load_seq}</dd>
                <dt>Checks</dt>
                <dd>
                  {run.checks ? (
                    <>
                      <Badge tone={totals.error === 0 ? "good" : "bad"}>{totals.error} error</Badge> <Badge tone={totals.warn === 0 ? "good" : "warn"}>{totals.warn} warn</Badge>
                    </>
                  ) : (
                    "not recorded"
                  )}
                </dd>
              </dl>
              <h3>Jobs and attempts</h3>
              {jobs.length === 0 ? (
                <p className="muted">No jobs.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Job</th>
                        <th>Attempt</th>
                        <th>Status</th>
                        <th>Claimed by</th>
                        <th>Queued to claim</th>
                        <th>Claim to finish</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...jobs]
                        .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.job_id.localeCompare(b.job_id))
                        .map((j) => (
                          <tr key={j.job_id}>
                            <td>{j.kind}</td>
                            <td>a{j.attempt}</td>
                            <td>
                              <Badge tone={outcomeTone(j.status)}>{j.status}</Badge>
                            </td>
                            <td className="mono">{j.claimed_by ?? "n/a"}</td>
                            <td>{duration(j.created_at, j.claimed_at)}</td>
                            <td>{duration(j.claimed_at, j.finished_at)}</td>
                            <td className="error-text">{j.result?.error ?? ""}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              {run.digests ? (
                <>
                  <h3>Output digests</h3>
                  <dl className="facts mono small">
                    {Object.entries(run.digests)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([model, digest]) => (
                        <div key={model} className="fact-row">
                          <dt>{model}</dt>
                          <dd>{digest.slice(0, 16)}</dd>
                        </div>
                      ))}
                  </dl>
                </>
              ) : null}
            </>
          );
        }}
      </Load>
    </section>
  );
}
