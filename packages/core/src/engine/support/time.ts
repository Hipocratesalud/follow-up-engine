const MS_PER_DAY = 86_400_000;

/** `date` plus a (possibly fractional) number of 24-hour days. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days from `from` to `to` (negative when `to` is earlier), rounded down. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** `YYYY-MM-DD` in UTC, used in idempotency keys. */
export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
