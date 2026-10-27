import type { ReactNode } from 'react';

/*
 * Small hand-drawn SVG charts of the Metrics view, to scale and in theme
 * tokens (they follow light and dark). Every mark carries a native tooltip
 * (`<title>`), every row is labelled in text, and each chart has a
 * screen-reader table, so no number is told by color alone.
 */

/** Series fills by identity, never by rank. */
export const SERIES_FILL = {
  primary: 'var(--primary)',
  info: 'var(--info)',
  neutral: 'var(--subtle)',
  success: 'var(--success)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
} as const;
export type SeriesTone = keyof typeof SERIES_FILL;

export interface BarSegment {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone: SeriesTone;
}

export interface BarRow {
  readonly key: string;
  readonly label: string;
  readonly segments: readonly BarSegment[];
  /** The value shown at the end of the row (default: the sum of the segments). */
  readonly display?: string;
}

const BAR_HEIGHT = 14;

function percent(value: number, max: number): number {
  return max <= 0 ? 0 : (value / max) * 100;
}

/**
 * Horizontal bars on one shared scale (the largest row is the full width),
 * stacked by segment. A 2px surface stroke separates segments.
 */
export function BarChart({
  rows,
  caption,
  max,
}: {
  readonly rows: readonly BarRow[];
  /** Screen-reader caption of the data table. */
  readonly caption: string;
  /** Scale maximum; default the largest row. */
  readonly max?: number;
}): ReactNode {
  const totals = rows.map((row) => row.segments.reduce((sum, segment) => sum + segment.value, 0));
  const scale = max ?? Math.max(0, ...totals);
  return (
    <figure className="flex flex-col gap-2.5">
      <ul className="flex flex-col gap-2.5" aria-hidden="true">
        {rows.map((row, index) => {
          let offset = 0;
          return (
            <li
              key={row.key}
              className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 max-sm:grid-cols-[minmax(0,7rem)_1fr_auto]"
            >
              <span className="truncate text-xs text-muted" title={row.label}>
                {row.label}
              </span>
              <svg
                width="100%"
                height={BAR_HEIGHT}
                role="presentation"
                className="overflow-visible"
              >
                <rect x="0" y="0" width="100%" height={BAR_HEIGHT} rx="4" fill="var(--surface-2)" />
                {row.segments.map((segment) => {
                  const x = percent(offset, scale);
                  const width = percent(segment.value, scale);
                  offset += segment.value;
                  return segment.value <= 0 ? null : (
                    <rect
                      key={segment.key}
                      x={`${String(x)}%`}
                      y="0"
                      width={`${String(width)}%`}
                      height={BAR_HEIGHT}
                      rx="4"
                      fill={SERIES_FILL[segment.tone]}
                      stroke="var(--surface)"
                      strokeWidth={width < 4 ? 0 : 2}
                    >
                      <title>{`${row.label} · ${segment.label}: ${String(segment.value)}`}</title>
                    </rect>
                  );
                })}
              </svg>
              <span className="min-w-8 text-right text-xs font-semibold text-fg tabular-nums">
                {row.display ?? String(totals[index] ?? 0)}
              </span>
            </li>
          );
        })}
      </ul>
      {/* A div clips it: a table ignores its own 1px width. */}
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.display ?? String(totals[index] ?? 0)}</td>
                <td>
                  {row.segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => `${segment.label}: ${String(segment.value)}`)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** The legend of a stacked chart: a swatch and a text label per series. */
export function Legend({
  items,
}: {
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly tone: SeriesTone;
  }[];
}): ReactNode {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-xs text-muted">
          <svg width="10" height="10" aria-hidden="true">
            <rect width="10" height="10" rx="3" fill={SERIES_FILL[item.tone]} />
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface QuantileMarker {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
}

/**
 * A duration distribution as markers on one axis from zero: the median, the
 * 75th and the 90th percentile, with the band between the median and the
 * 90th percentile shaded.
 */
export function QuantileStrip({
  markers,
  caption,
  summary,
}: {
  readonly markers: readonly QuantileMarker[];
  readonly caption: string;
  /** One sentence that says the same as the chart. */
  readonly summary: string;
}): ReactNode {
  const max = Math.max(...markers.map((marker) => marker.value), 0) * 1.1 || 1;
  const first = markers[0];
  const last = markers.at(-1);
  return (
    <figure className="flex flex-col gap-3">
      <svg width="100%" height="40" role="img" aria-label={summary} className="overflow-visible">
        <line x1="0" x2="100%" y1="20" y2="20" stroke="var(--border-strong)" strokeWidth="2" />
        {first && last ? (
          <rect
            x={`${String(percent(first.value, max))}%`}
            y="12"
            width={`${String(Math.max(percent(last.value - first.value, max), 0.5))}%`}
            height="16"
            rx="4"
            fill="var(--primary-soft)"
          />
        ) : null}
        {markers.map((marker, index) => (
          <circle
            key={marker.key}
            cx={`${String(percent(marker.value, max))}%`}
            cy="20"
            r={index === 0 ? 7 : 5}
            fill={index === 0 ? 'var(--primary)' : 'var(--surface)'}
            stroke="var(--primary)"
            strokeWidth="2"
          >
            <title>{`${marker.label}: ${marker.display}`}</title>
          </circle>
        ))}
      </svg>
      <dl className="grid grid-cols-3 gap-2">
        {markers.map((marker) => (
          <div key={marker.key} className="flex flex-col">
            <dt className="text-xs text-muted">{marker.label}</dt>
            <dd className="text-sm font-semibold text-fg tabular-nums">{marker.display}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}
