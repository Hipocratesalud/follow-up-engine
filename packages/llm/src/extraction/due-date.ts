import type { ModelTiming, TimeUnit } from './schema.ts';

const MS_PER_DAY = 86_400_000;
const DAYS_PER_UNIT: Record<TimeUnit, number> = { day: 1, week: 7, month: 30, year: 365 };

/** Adds whole calendar months in UTC, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addUtcMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(from.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * `from` plus a relative interval as a doctor writes it. Whole months and
 * years are calendar months ("ctrl en 3 meses" on Mar 10 is Jun 10);
 * fractional ones ("mes y medio") fall back to 30-day months. Days and
 * weeks are exact.
 */
export function addInterval(from: Date, amount: number, unit: TimeUnit): Date {
  if ((unit === 'month' || unit === 'year') && Number.isInteger(amount)) {
    return addUtcMonths(from, unit === 'year' ? amount * 12 : amount);
  }
  return new Date(from.getTime() + Math.round(amount * DAYS_PER_UNIT[unit]) * MS_PER_DAY);
}

/** Length of a treatment duration in days (months as 30 days, years as 365). */
export function durationInDays(amount: number, unit: TimeUnit): number {
  return Math.round(amount * DAYS_PER_UNIT[unit]);
}

/** Parses a strict `YYYY-MM-DD` calendar date to noon UTC, so it is the same day in every timezone of the Americas and Europe. */
export function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const roundTrips =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return roundTrips ? date : undefined;
}

export type DueAtResolution =
  | { readonly ok: true; readonly dueAt: Date }
  | { readonly ok: false; readonly reason: 'no_due_date' | 'due_before_note' };

/**
 * Turns what the model read ("en 15 días", "2025-06-01") into a due date.
 * The model never does date arithmetic: it reports the interval or the
 * explicit date, and this function computes the instant from the note's
 * `authoredAt`. Explicit dates before the note are rejected (they are
 * history, not plan).
 */
export function resolveDueAt(authoredAt: Date, timing: ModelTiming | null): DueAtResolution {
  if (!timing) return { ok: false, reason: 'no_due_date' };
  if (timing.date !== null) {
    const date = parseIsoDate(timing.date);
    if (date) {
      const sameDayOrLater = date.getTime() >= startOfUtcDay(authoredAt).getTime();
      return sameDayOrLater ? { ok: true, dueAt: date } : { ok: false, reason: 'due_before_note' };
    }
  }
  if (
    timing.amount !== null &&
    timing.unit !== null &&
    Number.isFinite(timing.amount) &&
    timing.amount > 0
  ) {
    return { ok: true, dueAt: addInterval(authoredAt, timing.amount, timing.unit) };
  }
  return { ok: false, reason: 'no_due_date' };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Whole days from `from` to `to`, rounded. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}
