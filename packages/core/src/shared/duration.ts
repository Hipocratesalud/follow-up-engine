/**
 * A span of time expressed in calendar-free units. Fields are summed, so
 * `{ hours: 1, minutes: 30 }` is ninety minutes. Days are fixed 24-hour
 * days: calendar arithmetic (months, DST-aware days) belongs to the domain,
 * not to this primitive.
 */
export interface Duration {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Raised when a {@link Duration} is not a finite, non-negative span. */
export class InvalidDurationError extends Error {
  override readonly name = 'InvalidDurationError';
  readonly duration: Duration;

  constructor(duration: Duration, reason: string) {
    super(`Invalid duration ${JSON.stringify(duration)}: ${reason}`);
    this.duration = duration;
  }
}

/**
 * Converts a {@link Duration} to milliseconds.
 *
 * @throws {InvalidDurationError} if any field is not a finite number or the
 * total is negative.
 */
export function durationToMilliseconds(duration: Duration): number {
  const { days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = duration;
  const parts = [days, hours, minutes, seconds, milliseconds];
  if (!parts.every(Number.isFinite)) {
    throw new InvalidDurationError(duration, 'every field must be a finite number');
  }
  const total =
    days * MS_PER_DAY +
    hours * MS_PER_HOUR +
    minutes * MS_PER_MINUTE +
    seconds * MS_PER_SECOND +
    milliseconds;
  if (total < 0) {
    throw new InvalidDurationError(duration, 'total must not be negative');
  }
  return total;
}
