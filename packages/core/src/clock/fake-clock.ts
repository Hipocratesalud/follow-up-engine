import type { Clock } from '../ports/clock.ts';
import { type Duration, durationToMilliseconds } from '../shared/duration.ts';

/** Raised when a {@link FakeClock} is given an invalid instant. */
export class InvalidInstantError extends Error {
  override readonly name = 'InvalidInstantError';

  constructor() {
    super('Invalid instant: expected a valid Date');
  }
}

function toEpochMilliseconds(instant: Date): number {
  const epochMs = instant.getTime();
  if (Number.isNaN(epochMs)) {
    throw new InvalidInstantError();
  }
  return epochMs;
}

/**
 * Manually driven {@link Clock}. Time only moves when the test says so.
 *
 * @example
 * ```ts
 * const clock = new FakeClock(new Date('2026-11-01T09:00:00Z'));
 * clock.advance({ days: 30 });
 * clock.now(); // 2026-12-01T09:00:00.000Z
 * ```
 */
export class FakeClock implements Clock {
  #epochMs: number;

  /** @param start the instant the clock reports until it is moved. */
  constructor(start: Date) {
    this.#epochMs = toEpochMilliseconds(start);
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  /**
   * Moves the clock forward and returns the new current instant.
   *
   * @throws {InvalidDurationError} if the duration is negative or not finite;
   * use {@link FakeClock.set} to move backwards on purpose.
   */
  advance(duration: Duration): Date {
    this.#epochMs += durationToMilliseconds(duration);
    return this.now();
  }

  /**
   * Jumps to an arbitrary instant, forwards or backwards (for example to
   * simulate host clock skew).
   *
   * @throws {InvalidInstantError} if `instant` is an invalid `Date`.
   */
  set(instant: Date): void {
    this.#epochMs = toEpochMilliseconds(instant);
  }
}
