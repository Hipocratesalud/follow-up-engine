import type { ReconciliationScope } from '../../domain/reconciliation.ts';
import type { ReconciliationSchedule } from '../../ports/clinic-directory.ts';

/** When the nightly reconciliation runs by default: 03:00 local, a full sweep on Sundays. */
export const DEFAULT_RECONCILIATION_SCHEDULE = {
  enabled: true,
  hour: 3,
  fullSweepWeekday: 0,
} as const satisfies Required<ReconciliationSchedule>;

const MS_PER_HOUR = 3_600_000;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
  } catch {
    // An unknown time zone in a clinic's settings: schedule on UTC rather than never.
    return formatterFor('UTC');
  }
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    weekday: WEEKDAYS[parts['weekday'] ?? 'Sun'] ?? 0,
  };
}

/** Minutes the zone is ahead of UTC at `instant` (Caracas: -240). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const local = localParts(instant, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time of the zone happens (the later one across a DST change). */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  const second = wall - offsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(Math.max(first, second));
}

/**
 * The next nightly run strictly after `now`: today's `hour` in the clinic's
 * time zone if it is still ahead, else tomorrow's. `scope` is `all` on the
 * full-sweep weekday (never with `fullSweepWeekday: null`), `recent` otherwise.
 */
export function nextReconciliationRun(
  now: Date,
  timeZone: string,
  schedule: ReconciliationSchedule = {},
): { readonly at: Date; readonly scope: ReconciliationScope } {
  const hour = schedule.hour ?? DEFAULT_RECONCILIATION_SCHEDULE.hour;
  const fullSweepWeekday =
    schedule.fullSweepWeekday === undefined
      ? DEFAULT_RECONCILIATION_SCHEDULE.fullSweepWeekday
      : schedule.fullSweepWeekday;
  const today = localParts(now, timeZone);
  let at = zonedInstant(today.year, today.month, today.day, hour, timeZone);
  if (at.getTime() <= now.getTime()) {
    // Noon of the next local day, then its `hour`: never skips or repeats a day across DST.
    const tomorrow = localParts(
      new Date(
        zonedInstant(today.year, today.month, today.day, 12, timeZone).getTime() + 24 * MS_PER_HOUR,
      ),
      timeZone,
    );
    at = zonedInstant(tomorrow.year, tomorrow.month, tomorrow.day, hour, timeZone);
  }
  const weekday = localParts(at, timeZone).weekday;
  return { at, scope: weekday === fullSweepWeekday ? 'all' : 'recent' };
}
