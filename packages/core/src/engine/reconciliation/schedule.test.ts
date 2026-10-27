import { describe, expect, it } from 'vitest';
import { nextReconciliationRun } from './schedule.ts';

describe('nextReconciliationRun', () => {
  it('is 03:00 in the clinic time zone, today while it is ahead, else tomorrow', () => {
    // Caracas is UTC-4: 03:00 there is 07:00Z.
    expect(nextReconciliationRun(new Date('2026-01-05T06:59:00Z'), 'America/Caracas').at).toEqual(
      new Date('2026-01-05T07:00:00Z'),
    );
    expect(nextReconciliationRun(new Date('2026-01-05T07:00:00Z'), 'America/Caracas').at).toEqual(
      new Date('2026-01-06T07:00:00Z'),
    );
    expect(nextReconciliationRun(new Date('2026-01-05T12:00:00Z'), 'America/Caracas').at).toEqual(
      new Date('2026-01-06T07:00:00Z'),
    );
  });

  it('honors the clinic hour and sweeps everyone on the full-sweep weekday', () => {
    const now = new Date('2026-01-05T12:00:00Z'); // Monday
    const next = nextReconciliationRun(now, 'UTC', { hour: 22, fullSweepWeekday: 1 });
    expect(next).toEqual({ at: new Date('2026-01-05T22:00:00Z'), scope: 'all' });
    expect(nextReconciliationRun(now, 'UTC', { hour: 1 })).toEqual({
      at: new Date('2026-01-06T01:00:00Z'),
      scope: 'recent',
    });
    // Sunday 2026-01-11 is the default full sweep; `null` switches full sweeps off.
    expect(nextReconciliationRun(new Date('2026-01-10T12:00:00Z'), 'UTC').scope).toBe('all');
    expect(
      nextReconciliationRun(new Date('2026-01-10T12:00:00Z'), 'UTC', { fullSweepWeekday: null })
        .scope,
    ).toBe('recent');
  });

  it('keeps one run per local night across a daylight saving change', () => {
    // Madrid moves from +1 to +2 at 02:00 on 2026-03-29: 03:00 local is 01:00Z that day.
    const before = nextReconciliationRun(new Date('2026-03-28T12:00:00Z'), 'Europe/Madrid');
    expect(before.at).toEqual(new Date('2026-03-29T01:00:00Z'));
    const after = nextReconciliationRun(before.at, 'Europe/Madrid');
    expect(after.at).toEqual(new Date('2026-03-30T01:00:00Z'));
  });

  it('falls back to UTC for an unknown time zone instead of never running', () => {
    expect(nextReconciliationRun(new Date('2026-01-05T12:00:00Z'), 'Mars/Olympus').at).toEqual(
      new Date('2026-01-06T03:00:00Z'),
    );
  });
});
