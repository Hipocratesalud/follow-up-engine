/**
 * Formatting of the Metrics view (HIP-141). Its words live in the i18n
 * catalogs (`t.metrics`, src/i18n/en.ts and es.ts); numbers, money and
 * dates follow the active locale here.
 */
import { type Locale, messagesFor } from '../../i18n/index.ts';
import type { MetricsPreset } from '../../i18n/metrics-copy.ts';

export type { MetricsPreset };
export const METRICS_PRESETS: readonly MetricsPreset[] = [7, 30, 90, 365];

const NUMBER_LOCALES: Readonly<Record<Locale, string>> = { en: 'en-US', es: 'es' };

/** Number formatters of a locale. */
export function metricsFormat(locale: Locale): {
  readonly percent: (ratio: number | undefined) => string;
  readonly usd: (amount: number | undefined) => string;
  readonly integer: (value: number) => string;
  readonly date: (iso: string) => string;
} {
  const tag = NUMBER_LOCALES[locale];
  const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const integer = new Intl.NumberFormat(tag);
  const date = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const none = messagesFor(locale).metrics.tiles.none;
  return {
    percent: (ratio) => (ratio === undefined ? none : percent.format(ratio)),
    usd: (amount) => (amount === undefined ? none : usd.format(amount)),
    integer: (value) => integer.format(value),
    date: (iso) => date.format(new Date(iso)),
  };
}
