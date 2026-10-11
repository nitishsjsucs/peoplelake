import { chartPoints, pathOf } from "../format.ts";

const BOX = { width: 720, height: 220, padX: 40, padY: 20 };

/** One metric over the 36 months of the window, as an inline SVG line with first and last labels. */
export function TrendChart({ series, title, format }: { series: { label: string; value: number | null }[]; title: string; format: (v: number) => string }) {
  const { points, min, max } = chartPoints(series, BOX);
  if (points.length === 0) return <p className="muted">No values to chart.</p>;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={title} preserveAspectRatio="none">
        <line className="chart-axis" x1={BOX.padX} y1={BOX.height - BOX.padY} x2={BOX.width - BOX.padX} y2={BOX.height - BOX.padY} />
        <text className="chart-tick" x={4} y={BOX.padY + 4}>
          {format(max)}
        </text>
        <text className="chart-tick" x={4} y={BOX.height - BOX.padY}>
          {format(min)}
        </text>
        <path className="chart-line" d={pathOf(points)} data-points={points.length} />
        {points.map((p) => (
          <circle key={p.label} className="chart-dot" cx={p.x} cy={p.y} r={2.5}>
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="muted">
        {title}: {first?.label} {first ? format(first.value) : ""} to {last?.label} {last ? format(last.value) : ""}
      </figcaption>
    </figure>
  );
}
