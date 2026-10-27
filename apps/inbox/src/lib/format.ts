import { getLocale, INTL_LOCALES, type Locale, messages } from '../i18n/index.ts';

/**
 * Dates, numbers and relative times, always through `Intl` in the active UI
 * locale (read at call time, so a locale switch takes effect on the next
 * render). Formatters are built once per locale.
 */

const DAY_MS = 86_400_000;

interface Formatters {
  readonly date: Intl.DateTimeFormat;
  readonly shortDate: Intl.DateTimeFormat;
  readonly longDate: Intl.DateTimeFormat;
  readonly dateTime: Intl.DateTimeFormat;
  readonly relative: Intl.RelativeTimeFormat;
  readonly usd: Intl.NumberFormat;
  readonly percent: Intl.NumberFormat;
  readonly number: Intl.NumberFormat;
  readonly decimal: Intl.NumberFormat;
  readonly languages: Intl.DisplayNames;
}

const cache = new Map<Locale, Formatters>();

function formatters(): Formatters {
  const locale = getLocale();
  const cached = cache.get(locale);
  if (cached) return cached;
  const tag = INTL_LOCALES[locale];
  const created: Formatters = {
    date: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' }),
    shortDate: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' }),
    longDate: new Intl.DateTimeFormat(tag, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
    dateTime: new Intl.DateTimeFormat(tag, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
    relative: new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }),
    // Latin American Spanish renders "USD 0.0012", which reads better than "0,0012 US$" for tiny amounts.
    usd: new Intl.NumberFormat(tag, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }),
    percent: new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 }),
    number: new Intl.NumberFormat(tag),
    decimal: new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }),
    languages: new Intl.DisplayNames([tag], { type: 'language' }),
  };
  cache.set(locale, created);
  return created;
}

/** "Oct 27, 2026" / "27 oct 2026" */
export function formatDate(iso: string): string {
  return formatters().date.format(new Date(iso));
}

/** "Jan 6" / "6 ene" (the year is implied: a date within the coming weeks). */
export function formatShortDate(iso: string): string {
  return formatters().shortDate.format(new Date(iso));
}

/** "Tuesday, October 27, 2026" / "martes, 27 de octubre de 2026" */
export function formatLongDate(iso: string): string {
  return formatters().longDate.format(new Date(iso));
}

/** "Oct 27, 01:05 PM" / "27 oct, 13:05" */
export function formatDateTime(iso: string): string {
  return formatters().dateTime.format(new Date(iso));
}

/** Whole days from `iso` to `now` (positive when `iso` is in the past). */
export function daysAgo(iso: string, now: Date): number {
  return Math.round((now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

/** "18 days ago", "yesterday", "today", "in 3 days", relative to the API clock. */
export function formatRelative(iso: string, now: Date): string {
  const days = daysAgo(iso, now);
  const { relative } = formatters();
  if (Math.abs(days) >= 60) {
    return relative.format(-Math.round(days / 30), 'month');
  }
  return relative.format(-days, 'day');
}

/**
 * "Overdue by 18 days" / "Was due today" / "Due today". `overdueDays` counts
 * calendar days (the API does, in the clinic's zone); on the deadline's own
 * day, `dueAt` against the API clock says whether it already passed.
 */
export function formatOverdue(overdueDays: number, dueAt?: string, now?: Date): string {
  const t = messages();
  if (overdueDays <= 0) {
    const passed = dueAt !== undefined && now !== undefined && Date.parse(dueAt) <= now.getTime();
    return passed ? t.time.dueTodayPassed : t.time.dueToday;
  }
  return t.time.overdue(overdueDays);
}

export function formatUsd(amount: number): string {
  return formatters().usd.format(amount);
}

export function formatPercent(ratio: number): string {
  return formatters().percent.format(ratio);
}

/** A count or a limit as the team reads it: "20,000" / "20.000". */
export function formatNumber(value: number): string {
  return formatters().number.format(value);
}

/** A measured value, at most two decimals: "1.75" / "1,75". */
export function formatDecimal(value: number): string {
  return formatters().decimal.format(value);
}

export function formatMs(ms: number): string {
  const t = messages();
  return ms >= 1000
    ? t.time.seconds(formatters().decimal.format(Math.round(ms / 100) / 10))
    : t.time.milliseconds(String(ms));
}

/**
 * A BCP-47 tag named in the active locale ("es-VE" → "Spanish (Venezuela)"
 * / "español (Venezuela)"); the tag itself when it cannot be named.
 */
export function formatLanguage(tag: string): string {
  try {
    const name = formatters().languages.of(tag);
    if (name === undefined) return tag;
    return name.charAt(0).toLocaleUpperCase(INTL_LOCALES[getLocale()]) + name.slice(1);
  } catch {
    return tag;
  }
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
