import { describe, expect, it } from 'vitest';
import { MEASUREMENTS } from './knowledge.ts';
import {
  changePct,
  ckdEpi2021,
  consecutiveWorsening,
  isOutOfRange,
  type SeriesPoint,
  slopePerYear,
  summarizeTrend,
} from './trends.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);

function series(values: readonly number[], everyDays = 90): SeriesPoint[] {
  return values.map((value, index) => ({
    handle: `R${String(index + 1)}`,
    at: new Date(T0 + index * everyDays * DAY),
    value,
  }));
}

const creatinine = MEASUREMENTS.find((measurement) => measurement.key === 'creatinine');
const weight = MEASUREMENTS.find((measurement) => measurement.key === 'weight');

describe('trend math (computed by code, never by the model)', () => {
  it('least-squares slope per year', () => {
    // +0.3 every 365.25 days is exactly 0.3 per year.
    expect(slopePerYear(series([1.0, 1.3, 1.6], 365.25))).toBeCloseTo(0.3, 6);
    expect(slopePerYear(series([2, 2, 2]))).toBe(0);
    expect(slopePerYear(series([5]))).toBe(0);
  });

  it('relative change from first to last', () => {
    expect(changePct(series([1.1, 1.4, 1.7]))).toBeCloseTo(54.545, 2);
    expect(changePct(series([80, 76]))).toBeCloseTo(-5, 6);
    expect(changePct(series([0, 3]))).toBe(0);
  });

  it('counts consecutive worsening steps ending at the latest value', () => {
    expect(consecutiveWorsening(series([1.0, 1.1, 1.4, 1.75]), 'up')).toBe(3);
    // The run is broken by an improvement, and by a flat step.
    expect(consecutiveWorsening(series([1.4, 1.1, 1.3, 1.5]), 'up')).toBe(2);
    expect(consecutiveWorsening(series([1.0, 1.2, 1.2]), 'up')).toBe(0);
    // Falling eGFR is worsening.
    expect(consecutiveWorsening(series([70, 60, 48]), 'down')).toBe(2);
    expect(consecutiveWorsening(series([70, 60, 48]), 'up')).toBe(0);
    // Weight: a steady change in either direction.
    expect(consecutiveWorsening(series([82, 79, 76, 72]), 'either')).toBe(3);
    expect(consecutiveWorsening(series([70, 72, 71]), 'either')).toBe(1);
  });

  it('flags out-of-range values against low and high', () => {
    expect(isOutOfRange(1.75, { high: 1.2 })).toBe(true);
    expect(isOutOfRange(1.2, { high: 1.2 })).toBe(false);
    expect(isOutOfRange(40, { low: 60 })).toBe(true);
  });

  it('summarizes a series in its order of time, whatever the input order', () => {
    if (creatinine === undefined || weight === undefined) throw new Error('catalog');
    const points = series([1.1, 1.4, 1.75]);
    const summary = summarizeTrend(creatinine, [points[2], points[0], points[1]] as SeriesPoint[]);
    expect(summary).toMatchObject({
      test: 'creatinine',
      unit: 'mg/dL',
      changePct: 59.1,
      consecutiveWorsening: 2,
      direction: 'up',
      latestOutOfRange: true,
    });
    expect(summary.points.map((point) => point.handle)).toEqual(['R1', 'R2', 'R3']);
    expect(summarizeTrend(weight, series([70, 70.3])).direction).toBe('flat');
  });

  it('estimates eGFR with the race-free CKD-EPI 2021 equation', () => {
    // Reference values of the 2021 equation (Inker et al.).
    expect(ckdEpi2021(1.0, 50, false)).toBe(92);
    expect(ckdEpi2021(0.8, 60, true)).toBe(84);
    // The planted patient: a 68-year-old man with a creatinine of 1.75.
    expect(ckdEpi2021(1.75, 68, false)).toBeLessThan(45);
    expect(ckdEpi2021(1.75, 68, false)).toBeGreaterThan(30);
  });
});
