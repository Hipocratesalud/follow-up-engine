import type { ReactNode } from 'react';
import { SERIES_FILL } from '../metrics/charts.tsx';
import type { Interval } from './contract.ts';

/*
 * Control against agent, one pair of thin bars per row on one 0–100 %
 * scale, each with its 95 % interval as a whisker. Theme tokens only
 * (light and dark), a native tooltip on every bar, the values in text at
 * the end of the row and a screen-reader table: nothing is told by color
 * alone.
 */

export interface PairedRow {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly control: Interval;
  readonly agent: Interval;
  /** Text at the end of the row (for example "51 % → 75 %"). */
  readonly display: string;
  /** The difference, in text (for example "+24 pts"). */
  readonly delta: string;
}

const BAR = 9;
const GAP = 5;
const HEIGHT = BAR * 2 + GAP + 4;

function x(ratio: number): string {
  return `${String(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function Whisker({ interval, y }: { readonly interval: Interval; readonly y: number }): ReactNode {
  const mid = y + BAR / 2;
  return (
    <g stroke="var(--fg)" strokeOpacity="0.55" strokeWidth="1.5">
      <line x1={x(interval.low)} x2={x(interval.high)} y1={mid} y2={mid} />
      <line x1={x(interval.low)} x2={x(interval.low)} y1={mid - 3} y2={mid + 3} />
      <line x1={x(interval.high)} x2={x(interval.high)} y1={mid - 3} y2={mid + 3} />
    </g>
  );
}

export function PairedBars({
  rows,
  caption,
  labels,
  format,
}: {
  readonly rows: readonly PairedRow[];
  readonly caption: string;
  readonly labels: { readonly control: string; readonly agent: string };
  readonly format: (interval: Interval) => string;
}): ReactNode {
  return (
    <figure className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3" aria-hidden="true">
        {rows.map((row) => (
          <li
            key={row.key}
            className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 max-sm:grid-cols-[minmax(0,7.5rem)_1fr_auto]"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-xs font-medium break-words text-fg" title={row.label}>
                {row.label}
              </span>
              {row.hint === undefined ? null : (
                <span className="truncate text-[11px] text-muted">{row.hint}</span>
              )}
            </span>
            <svg width="100%" height={HEIGHT} role="presentation" className="overflow-visible">
              <rect x="0" y="0" width="100%" height={BAR} rx="3" fill="var(--surface-2)" />
              <rect x="0" y={BAR + GAP} width="100%" height={BAR} rx="3" fill="var(--surface-2)" />
              <rect
                x="0"
                y="0"
                width={x(row.control.mean)}
                height={BAR}
                rx="3"
                fill={SERIES_FILL.neutral}
              >
                <title>{`${row.label} · ${labels.control}: ${format(row.control)}`}</title>
              </rect>
              <rect
                x="0"
                y={BAR + GAP}
                width={x(row.agent.mean)}
                height={BAR}
                rx="3"
                fill={SERIES_FILL.primary}
              >
                <title>{`${row.label} · ${labels.agent}: ${format(row.agent)}`}</title>
              </rect>
              <Whisker interval={row.control} y={0} />
              <Whisker interval={row.agent} y={BAR + GAP} />
            </svg>
            <span className="flex flex-col items-end text-right">
              <span className="text-xs font-semibold text-fg tabular-nums">{row.display}</span>
              <span className="text-[11px] text-muted tabular-nums">{row.delta}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{caption}</th>
              <th scope="col">{labels.control}</th>
              <th scope="col">{labels.agent}</th>
              <th scope="col">{row0Delta(rows)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{format(row.control)}</td>
                <td>{format(row.agent)}</td>
                <td>{row.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** The difference column has no header word of its own: the sign says it. */
function row0Delta(rows: readonly PairedRow[]): string {
  return rows.length === 0 ? '' : '±';
}

/** The legend: a swatch and a text label per arm. */
export function ArmLegend({
  labels,
  intervalLabel,
}: {
  readonly labels: { readonly control: string; readonly agent: string };
  readonly intervalLabel: string;
}): ReactNode {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      <li className="flex items-center gap-1.5 text-xs text-muted">
        <svg width="10" height="10" aria-hidden="true">
          <rect width="10" height="10" rx="3" fill={SERIES_FILL.neutral} />
        </svg>
        {labels.control}
      </li>
      <li className="flex items-center gap-1.5 text-xs text-muted">
        <svg width="10" height="10" aria-hidden="true">
          <rect width="10" height="10" rx="3" fill={SERIES_FILL.primary} />
        </svg>
        {labels.agent}
      </li>
      <li className="flex items-center gap-1.5 text-xs text-muted">
        <svg width="14" height="10" aria-hidden="true">
          <g stroke="var(--fg)" strokeOpacity="0.55" strokeWidth="1.5">
            <line x1="1" x2="13" y1="5" y2="5" />
            <line x1="1" x2="1" y1="2" y2="8" />
            <line x1="13" x2="13" y1="2" y2="8" />
          </g>
        </svg>
        {intervalLabel}
      </li>
    </ul>
  );
}
