import { api, type RunFull } from "../api.ts";
import { Badge, Load } from "../components/Status.tsx";
import { checkTotals } from "../format.ts";
import { useApi } from "../useApi.ts";

/** Error-level checks block a commit; warn-level checks are completeness checks that must reach 0 at quiescence. */
export function ChecksPage() {
  const [runs] = useApi<{ runs: RunFull[] }>(() => api.runs(50));
  return (
    <section aria-labelledby="checks-title">
      <h2 id="checks-title">Checks</h2>
      <p className="muted small">
        Reconciliation checks per run (R1 to R11 and the as-of check). Error-level failures block the commit; warn-level ones may be non-zero while late data is still
        arriving and must be 0 once delivery is complete. Runs that loaded nothing new reuse the previous checks and are not listed.
      </p>
      <Load value={runs}>
        {({ runs: rows }) => {
          const checked = rows.filter((r) => r.checks !== null && !r.transform_skipped);
          if (checked.length === 0) return <p className="muted">No runs with checks yet.</p>;
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Outcome</th>
                    <th className="num">Error</th>
                    <th className="num">Warn</th>
                    <th>Non-zero checks</th>
                  </tr>
                </thead>
                <tbody>
                  {checked.map((r) => {
                    const totals = checkTotals(r.checks);
                    const nonZero = [
                      ...Object.entries(r.checks?.error ?? {}).map(([k, v]) => [k, v, "error"] as const),
                      ...Object.entries(r.checks?.warn ?? {}).map(([k, v]) => [k, v, "warn"] as const),
                    ].filter(([, v]) => v > 0);
                    return (
                      <tr key={r.run_id}>
                        <td className="mono">
                          <a href={`#/runs/${r.run_id}`}>{r.run_id}</a>
                        </td>
                        <td>{r.status}</td>
                        <td className="num">
                          <Badge tone={totals.error === 0 ? "good" : "bad"}>{totals.error}</Badge>
                        </td>
                        <td className="num">
                          <Badge tone={totals.warn === 0 ? "good" : "warn"}>{totals.warn}</Badge>
                        </td>
                        <td className="small">{nonZero.length === 0 ? "none" : nonZero.map(([k, v, level]) => `${k} (${level}) ${v}`).join(", ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </Load>
    </section>
  );
}
