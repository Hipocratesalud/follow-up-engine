import type { Clock } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';

/**
 * Contract every {@link Clock} adapter must satisfy. Adapters register it
 * from their own test file:
 *
 * ```ts
 * describeClockContract('SystemClock', () => new SystemClock());
 * ```
 */
export function describeClockContract(name: string, createClock: () => Clock): void {
  describe(`Clock contract: ${name}`, () => {
    it('returns a valid Date', () => {
      expect(Number.isNaN(createClock().now().getTime())).toBe(false);
    });

    it('never goes backwards between consecutive reads', () => {
      const clock = createClock();
      const first = clock.now().getTime();
      const second = clock.now().getTime();
      expect(second).toBeGreaterThanOrEqual(first);
    });

    it('cannot be mutated through a returned Date', () => {
      const clock = createClock();
      const before = clock.now().getTime();
      clock.now().setTime(0);
      expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
    });
  });
}
