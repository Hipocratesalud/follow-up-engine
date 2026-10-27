import type { MeasurementDefinition } from './knowledge.ts';

const MS_PER_YEAR = 365.25 * 86_400_000;

/** One value of a series, in the measurement's unit. */
export interface SeriesPoint {
  /** Document handle of the result (`R3`), what a citation points at. */
  readonly handle: string;
  readonly at: Date;
  readonly value: number;
}

/**
 * The trend of a measurement, computed by code (never by the model):
 * least-squares slope, change from first to last, the run of consecutive
 * worsening steps that ends at the latest value, and whether the latest
 * value is out of range.
 */
export interface TrendSummary {
  readonly test: string;
  readonly label: string;
  readonly unit: string;
  readonly kind: 'lab' | 'vital';
  readonly points: readonly SeriesPoint[];
  readonly low?: number;
  readonly high?: number;
  readonly worseWhen: 'up' | 'down' | 'either';
  /** Units per year (least squares over time). 0 with fewer than 2 points. */
  readonly slopePerYear: number;
  /** (last − first) / first × 100. */
  readonly changePct: number;
  /** Steps in a row, ending at the latest value, that moved the worse way (`either`: the same way). */
  readonly consecutiveWorsening: number;
  readonly direction: 'up' | 'down' | 'flat';
  readonly latestOutOfRange: boolean;
}

/** Least-squares slope of `value` over time, in units per year. */
export function slopePerYear(points: readonly SeriesPoint[]): number {
  if (points.length < 2) return 0;
  const xs = points.map((point) => point.at.getTime() / MS_PER_YEAR);
  const ys = points.map((point) => point.value);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    numerator += dx * ((ys[index] ?? 0) - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Relative change from the first to the last value, in percent (0 when the first is 0). */
export function changePct(points: readonly SeriesPoint[]): number {
  const first = points[0]?.value;
  const last = points.at(-1)?.value;
  if (first === undefined || last === undefined || first === 0) return 0;
  return ((last - first) / Math.abs(first)) * 100;
}

/**
 * Consecutive steps, ending at the latest value, that moved the worse way.
 * `either` counts steps in the direction of the last step. A flat step
 * breaks the run.
 */
export function consecutiveWorsening(
  points: readonly SeriesPoint[],
  worseWhen: 'up' | 'down' | 'either',
): number {
  let count = 0;
  let direction: 1 | -1 | undefined =
    worseWhen === 'up' ? 1 : worseWhen === 'down' ? -1 : undefined;
  for (let index = points.length - 1; index > 0; index -= 1) {
    const delta = (points[index]?.value ?? 0) - (points[index - 1]?.value ?? 0);
    const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (sign === 0) break;
    direction ??= sign;
    if (sign !== direction) break;
    count += 1;
  }
  return count;
}

export function isOutOfRange(
  value: number,
  range: { readonly low?: number | undefined; readonly high?: number | undefined },
): boolean {
  return (
    (range.high !== undefined && value > range.high) ||
    (range.low !== undefined && value < range.low)
  );
}

/** The trend of a series (sorted by time first; ties keep their order). */
export function summarizeTrend(
  measurement: MeasurementDefinition,
  series: readonly SeriesPoint[],
  label: string = measurement.key,
): TrendSummary {
  const points = [...series].sort((left, right) => left.at.getTime() - right.at.getTime());
  const change = changePct(points);
  const latest = points.at(-1)?.value;
  return {
    test: measurement.key,
    label,
    unit: measurement.unit,
    kind: measurement.kind,
    points,
    ...(measurement.low === undefined ? {} : { low: measurement.low }),
    ...(measurement.high === undefined ? {} : { high: measurement.high }),
    worseWhen: measurement.worseWhen,
    slopePerYear: round(slopePerYear(points), 3),
    changePct: round(change, 1),
    consecutiveWorsening: consecutiveWorsening(points, measurement.worseWhen),
    direction: Math.abs(change) < 1 ? 'flat' : change > 0 ? 'up' : 'down',
    latestOutOfRange: latest !== undefined && isOutOfRange(latest, measurement),
  };
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A number as the clinic reads it: fixed decimals, trailing zeros dropped (`1.7`, `142`). */
export function formatValue(value: number, decimals: number): string {
  return String(round(value, decimals));
}

/**
 * eGFR (mL/min/1.73 m²) from serum creatinine with the race-free CKD-EPI
 * 2021 equation (Inker et al., NEJM 2021). Used when a host sends creatinine
 * but no eGFR, so a drug-renal check still has a filtration rate.
 */
export function ckdEpi2021(creatinineMgDl: number, ageYears: number, female: boolean): number {
  const kappa = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const ratio = creatinineMgDl / kappa;
  const value =
    142 *
    Math.min(ratio, 1) ** alpha *
    Math.max(ratio, 1) ** -1.2 *
    0.9938 ** ageYears *
    (female ? 1.012 : 1);
  return round(value, 0);
}
