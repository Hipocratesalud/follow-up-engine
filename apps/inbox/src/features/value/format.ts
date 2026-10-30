/**
 * Number formatting of the Value view: every number follows the active
 * locale. Shares arrive as ratios (0..1).
 */
import { type Locale, INTL_LOCALES } from '../../i18n/index.ts';

export interface ValueFormat {
  /** 0.506 → "50.6 %" (EN) / "50,6 %" (ES). */
  readonly percent: (ratio: number) => string;
  /** A share difference in percentage points, signed: 0.24 → "+24.0". */
  readonly points: (ratio: number) => string;
  readonly decimal: (value: number) => string;
  readonly integer: (value: number) => string;
  readonly money: (value: number) => string;
}

export function valueFormat(locale: Locale, currency: string): ValueFormat {
  const tag = INTL_LOCALES[locale];
  const percent = new Intl.NumberFormat(tag, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const points = new Intl.NumberFormat(tag, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  const decimal = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
  return {
    percent: (ratio) => percent.format(ratio),
    points: (ratio) => points.format(ratio * 100),
    decimal: (value) => decimal.format(value),
    integer: (value) => integer.format(value),
    money: (value) => money.format(value),
  };
}
