import type { Clock } from '../ports/clock.ts';

/** {@link Clock} backed by the host's wall clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
