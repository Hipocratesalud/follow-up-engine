import { INTL_LOCALES, type Locale } from '../../i18n/index.ts';

/** "Tue, Jan 6, 08:00" in the clinic's own time zone (the agent's clock), never ISO. */
export function clinicDateTime(iso: string, timeZone: string | undefined, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    ...(timeZone === undefined ? {} : { timeZone }),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "Jan 6, 2026" in the clinic's own time zone. */
export function clinicDate(iso: string, timeZone: string | undefined, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

/** "08:00" in the clinic's own time zone. */
export function clinicTime(iso: string, timeZone: string | undefined, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "$0.0123": costs of a few model calls need four decimals. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 3)}`;
}
