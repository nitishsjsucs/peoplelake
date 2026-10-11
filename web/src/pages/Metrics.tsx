import { useState } from "react";
import { api, type MetricsSnapshot } from "../api.ts";
import { Load } from "../components/Status.tsx";
import { TrendChart } from "../components/TrendChart.tsx";
import { DEPARTMENTS, METRICS, type MetricKey, metricValue, monthLabel, rowsFor } from "../format.ts";
import { useApi } from "../useApi.ts";

export function Metrics() {
  const [snapshot] = useApi<MetricsSnapshot>(() => api.metrics());
  const [department, setDepartment] = useState("ALL");
  const [metric, setMetric] = useState<MetricKey>("headcount");
  const meta = METRICS.find((m) => m.id === metric) ?? METRICS[0];
  return (
    <section aria-labelledby="metrics-title">
      <h2 id="metrics-title">Metrics</h2>
      <Load value={snapshot} empty={{ 404: "No committed metrics yet: the first committed warehouse run publishes them." }}>
        {(s) => {
          const rows = rowsFor(s.rows, department);
          return (
            <>
              <p className="muted small">
                From the committed snapshot of run <span className="mono">{s.run_id}</span> ({s.rows.length} rows, engine {s.engine}, profile {s.profile}). Every number comes from{" "}
                <span className="mono">metrics_workforce_monthly</span>.
              </p>
              <div className="controls">
                <label>
                  Department{" "}
                  <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                    {Object.entries(DEPARTMENTS).map(([id, name]) => (
                      <option key={id} value={id}>
                        {id === "ALL" ? name : `${id} ${name}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Metric{" "}
                  <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
                    {METRICS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <TrendChart
                title={`${meta.label} (${meta.hint}), ${DEPARTMENTS[department] ?? department}`}
                series={rows.map((r) => ({ label: monthLabel(r.month), value: r[metric] === null ? null : Number(r[metric]) }))}
                format={(v) => metricValue(metric, String(v))}
              />
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th>
                      {METRICS.map((m) => (
                        <th key={m.id} className="num" title={m.hint}>
                          {m.label}
                        </th>
                      ))}
                      <th className="num">Rehires</th>
                      <th className="num">Transfers in</th>
                      <th className="num">Transfers out</th>
                      <th className="num">Offers accepted</th>
                      <th className="num">Offers declined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.month}>
                        <td className="mono">{monthLabel(r.month)}</td>
                        {METRICS.map((m) => (
                          <td key={m.id} className="num">
                            {metricValue(m.id, r[m.id])}
                          </td>
                        ))}
                        <td className="num">{r.rehires ?? "n/a"}</td>
                        <td className="num">{r.transfers_in ?? "n/a"}</td>
                        <td className="num">{r.transfers_out ?? "n/a"}</td>
                        <td className="num">{r.offers_accepted ?? "n/a"}</td>
                        <td className="num">{r.offers_declined ?? "n/a"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Load>
    </section>
  );
}
