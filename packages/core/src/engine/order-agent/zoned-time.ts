/**
 * Wall-clock arithmetic in a clinic's IANA time zone, with the platform's
 * `Intl` only (no library, no I/O). Slots, "this week" and the ladder's
 * days are computed in the clinic's own time, never in UTC.
 */

export interface ZonedParts {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (existing === undefined) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

/** The wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')) % 24,
    minute: Number(value('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(value('weekday'))),
  };
}

/** The instant whose wall-clock time in `timeZone` is the given local date and time. */
export function zonedInstant(
  local: { readonly year: number; readonly month: number; readonly day: number },
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, hour, minute);
  // Two passes settle any offset, DST transitions included.
  let instant = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instant += guess - asUtc;
  }
  return new Date(instant);
}

/** The local calendar day `days` after the local day of `date`. */
export function addLocalDays(
  date: Date,
  days: number,
  timeZone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
} {
  const parts = zonedParts(date, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
