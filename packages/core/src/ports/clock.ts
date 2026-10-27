/**
 * Source of the current time.
 *
 * The engine never reads the wall clock directly: deadlines, escalations and
 * audit timestamps all derive from this port, so a whole scenario ("the
 * patient never booked the follow-up, thirty days pass") can be replayed
 * deterministically with a fake clock.
 *
 * Adapters: `SystemClock` (production), `FakeClock` (tests, demos, evals).
 */
export interface Clock {
  /**
   * Returns the current instant. Every call returns a fresh `Date`, so
   * callers may not mutate the clock through the returned value.
   */
  now(): Date;
}
