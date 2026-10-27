import { describe, expect, it } from 'vitest';
import { SystemClock } from './system-clock.ts';

describe('SystemClock', () => {
  it('returns the wall-clock time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('returns a fresh Date on every call', () => {
    const clock = new SystemClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});
