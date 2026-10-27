/**
 * FHIR `date` / `dateTime` / `instant` handling.
 *
 * FHIR allows partial dates (`2026`, `2026-01`, `2026-01-05`) and requires a
 * timezone whenever a time is present. Partial values are read as the start
 * of the period they denote, in UTC.
 */

/** FHIR R4 `dateTime` regular expression (http://hl7.org/fhir/R4/datatypes.html#dateTime). */
export const FHIR_DATE_TIME_PATTERN =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/;

const MS_PER_DAY = 86_400_000;

/** Parses a FHIR `date`/`dateTime`/`instant` into a `Date`; `undefined` if absent or invalid. */
export function parseFhirDateTime(value: string | undefined): Date | undefined {
  if (value === undefined || !FHIR_DATE_TIME_PATTERN.test(value)) {
    return undefined;
  }
  const normalized =
    value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
  const date = new Date(normalized.length === 10 ? `${normalized}T00:00:00Z` : normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** First parseable value of the candidates, in order. */
export function firstDate(...candidates: readonly (string | undefined)[]): Date | undefined {
  for (const candidate of candidates) {
    const date = parseFhirDateTime(candidate);
    if (date !== undefined) {
      return date;
    }
  }
  return undefined;
}

/** Serializes a `Date` as a FHIR `instant`/`dateTime` (UTC, millisecond precision). */
export function toFhirInstant(date: Date): string {
  return date.toISOString();
}

/** Whole days between two instants, rounded up; never negative. */
export function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY));
}

/** Days per UCUM time unit, as used by FHIR `Duration` (`code`) or its free-text `unit`. */
const DAYS_PER_UNIT: Readonly<Record<string, number>> = {
  min: 1 / 1_440,
  h: 1 / 24,
  d: 1,
  wk: 7,
  mo: 30,
  a: 365,
};

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  minute: 'min',
  minutes: 'min',
  hour: 'h',
  hours: 'h',
  day: 'd',
  days: 'd',
  dia: 'd',
  dias: 'd',
  días: 'd',
  día: 'd',
  week: 'wk',
  weeks: 'wk',
  semana: 'wk',
  semanas: 'wk',
  month: 'mo',
  months: 'mo',
  mes: 'mo',
  meses: 'mo',
  year: 'a',
  years: 'a',
  año: 'a',
  años: 'a',
};

/** A FHIR `Duration`/`Quantity` (only the fields read here). */
export interface DurationLike {
  readonly value?: number | undefined;
  readonly unit?: string | undefined;
  readonly code?: string | undefined;
}

/**
 * Converts a FHIR `Duration` to whole days (rounded up). Reads the UCUM
 * `code` first and falls back to the human `unit`. `undefined` when the unit
 * is unknown or the value is missing or not positive.
 */
export function durationToDays(duration: DurationLike | undefined): number | undefined {
  if (duration?.value === undefined || !(duration.value > 0)) {
    return undefined;
  }
  const raw = (duration.code ?? duration.unit ?? '').trim().toLowerCase();
  const unit = Object.hasOwn(DAYS_PER_UNIT, raw)
    ? raw
    : Object.hasOwn(UNIT_ALIASES, raw)
      ? UNIT_ALIASES[raw]
      : undefined;
  const factor = unit === undefined ? undefined : DAYS_PER_UNIT[unit];
  return factor === undefined ? undefined : Math.ceil(duration.value * factor);
}
