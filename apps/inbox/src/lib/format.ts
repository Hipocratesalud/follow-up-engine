const DAY_MS = 86_400_000;
const LOCALE = 'es';

const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const longDateFormat = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
// Latin American Spanish renders "USD 0.0012", which reads better than "0,0012 US$" for tiny amounts.
const usdFormat = new Intl.NumberFormat('es-419', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const percentFormat = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 });

/** "27 oct 2026" */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

const shortDateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });

/** "6 ene" (the year is implied: a date within the coming weeks). */
export function formatShortDate(iso: string): string {
  return shortDateFormat.format(new Date(iso));
}

/** "martes, 27 de octubre de 2026" */
export function formatLongDate(iso: string): string {
  return longDateFormat.format(new Date(iso));
}

/** "27 oct, 13:05" */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** Whole days from `iso` to `now` (positive when `iso` is in the past). */
export function daysAgo(iso: string, now: Date): number {
  return Math.round((now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

/** "hace 18 días", "ayer", "hoy", "en 3 días", relative to the API clock. */
export function formatRelative(iso: string, now: Date): string {
  const days = daysAgo(iso, now);
  if (Math.abs(days) >= 60) {
    return relativeFormat.format(-Math.round(days / 30), 'month');
  }
  return relativeFormat.format(-days, 'day');
}

/**
 * "Vencido hace 18 días" / "Venció hoy" / "Vence hoy". `overdueDays` counts
 * calendar days (the API does, in the clinic's zone); on the deadline's own
 * day, `dueAt` against the API clock says whether it already passed.
 */
export function formatOverdue(overdueDays: number, dueAt?: string, now?: Date): string {
  if (overdueDays <= 0) {
    const passed = dueAt !== undefined && now !== undefined && Date.parse(dueAt) <= now.getTime();
    return passed ? 'Venció hoy' : 'Vence hoy';
  }
  if (overdueDays === 1) return 'Vencido hace 1 día';
  return `Vencido hace ${String(overdueDays)} días`;
}

export function formatUsd(amount: number): string {
  return usdFormat.format(amount);
}

export function formatPercent(ratio: number): string {
  return percentFormat.format(ratio);
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${String(ms)} ms`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
