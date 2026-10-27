import type { ReactNode } from 'react';
import type { FindingTrend } from '../../api/reviewer-contract.ts';
import { formatDate, formatShortDate } from '../../lib/format.ts';
import { REVIEW_COPY } from './copy.ts';

const COPY = REVIEW_COPY.trend;

const WIDTH = 420;
const HEIGHT = 170;
const PAD = { top: 14, right: 14, bottom: 30, left: 46 } as const;

function formatValue(value: number): string {
  return value.toLocaleString('es', { maximumFractionDigits: 2 });
}

/** "Creatinina: 1,05 → 1,1 → 1,75 mg/dL entre el 12 jul 2024 y el 20 nov 2025". */
export function trendDescription(trend: FindingTrend): string {
  const first = trend.points[0];
  const last = trend.points.at(-1);
  const values = trend.points.map((point) => formatValue(point.value)).join(' → ');
  const range = first && last ? COPY.range(formatDate(first.date), formatDate(last.date)) : '';
  const reference = [
    trend.low === undefined ? undefined : COPY.low(formatValue(trend.low)),
    trend.high === undefined ? undefined : COPY.high(formatValue(trend.high)),
  ].filter((part): part is string => part !== undefined);
  return COPY.description(
    trend.label,
    values,
    trend.unit,
    range,
    reference.length > 0 ? COPY.reference(reference.join(', ')) : '',
  );
}

/**
 * The cited measurement over time, drawn to scale: x by date, y from the
 * lowest to the highest of the values and the reference limits, with the
 * reference limits as dashed lines and the cited results emphasized.
 */
export function TrendChart({ trend }: { readonly trend: FindingTrend }): ReactNode {
  const points = trend.points;
  if (points.length === 0) return null;
  const times = points.map((point) => new Date(point.date).getTime());
  const values = points.map((point) => point.value);
  const limits = [trend.low, trend.high].filter((value): value is number => value !== undefined);
  let min = Math.min(...values, ...limits);
  let max = Math.max(...values, ...limits);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const margin = (max - min) * 0.1;
  min -= margin;
  max += margin;
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (time: number): number =>
    tMax === tMin
      ? PAD.left + plotWidth / 2
      : PAD.left + ((time - tMin) / (tMax - tMin)) * plotWidth;
  const y = (value: number): number => PAD.top + (1 - (value - min) / (max - min)) * plotHeight;
  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(times[index] ?? 0).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .join(' ');
  const ticks = [min + margin, (min + max) / 2, max - margin];
  const first = points[0];
  const last = points.at(-1);

  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
        <span className="font-medium text-fg">{COPY.caption(trend.label, trend.unit)}</span>
        <span>
          {COPY.values(points.length)}
          {trend.high !== undefined || trend.low !== undefined ? COPY.referenceLegend : ''}
        </span>
      </figcaption>
      <svg
        role="img"
        aria-label={trendDescription(trend)}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        className="h-auto w-full max-w-[520px] text-muted"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-current text-[13px]"
            >
              {formatValue(Math.round(tick * 100) / 100)}
            </text>
          </g>
        ))}
        {limits.map((limit) => (
          <line
            key={`limit-${String(limit)}`}
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(limit)}
            y2={y(limit)}
            className="stroke-warning"
            strokeWidth={1.25}
            strokeDasharray="5 4"
          />
        ))}
        <path d={path} fill="none" className="stroke-primary" strokeWidth={2} />
        {points.map((point, index) => (
          <circle
            key={`${point.docId}-${point.date}`}
            cx={x(times[index] ?? 0)}
            cy={y(point.value)}
            r={point.cited ? 5 : 3.5}
            className={point.cited ? 'fill-primary stroke-surface' : 'fill-surface stroke-primary'}
            strokeWidth={2}
          />
        ))}
        {first ? (
          <text x={PAD.left} y={HEIGHT - 8} className="fill-current text-[13px]">
            {formatShortDate(first.date)} {new Date(first.date).getUTCFullYear()}
          </text>
        ) : null}
        {last && points.length > 1 ? (
          <text
            x={WIDTH - PAD.right}
            y={HEIGHT - 8}
            textAnchor="end"
            className="fill-current text-[13px]"
          >
            {formatShortDate(last.date)} {new Date(last.date).getUTCFullYear()}
          </text>
        ) : null}
      </svg>
      <table className="sr-only">
        <caption>{trend.label}</caption>
        <thead>
          <tr>
            <th scope="col">{COPY.dateHeader}</th>
            <th scope="col">{COPY.valueHeader(trend.unit)}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={`${point.docId}-${point.date}-row`}>
              <td>{formatDate(point.date)}</td>
              <td>
                {formatValue(point.value)}
                {point.cited ? COPY.cited : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
