import { describe, expect, it } from 'vitest';
import { InvalidDurationError } from '../shared/duration.ts';
import { FakeClock, InvalidInstantError } from './fake-clock.ts';

const START = new Date('2026-11-01T09:00:00.000Z');

describe('FakeClock', () => {
  it('reports the start instant until moved', () => {
    const clock = new FakeClock(START);
    expect(clock.now().toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });

  it('advances by a composite duration', () => {
    const clock = new FakeClock(START);
    const next = clock.advance({ days: 30, hours: 1, minutes: 30, seconds: 5, milliseconds: 7 });
    expect(next.toISOString()).toBe('2026-12-01T10:30:05.007Z');
    expect(clock.now().toISOString()).toBe('2026-12-01T10:30:05.007Z');
  });

  it('accumulates successive advances', () => {
    const clock = new FakeClock(START);
    clock.advance({ days: 1 });
    clock.advance({ hours: 12 });
    expect(clock.now().toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });

  it('treats an empty duration as zero', () => {
    const clock = new FakeClock(START);
    expect(clock.advance({}).getTime()).toBe(START.getTime());
  });

  it('rejects negative or non-finite durations without moving', () => {
    const clock = new FakeClock(START);
    expect(() => clock.advance({ days: -1 })).toThrow(InvalidDurationError);
    expect(() => clock.advance({ hours: Number.NaN })).toThrow(InvalidDurationError);
    expect(() => clock.advance({ seconds: Number.POSITIVE_INFINITY })).toThrow(
      InvalidDurationError,
    );
    expect(clock.now().getTime()).toBe(START.getTime());
  });

  it('allows a negative field when the total is non-negative', () => {
    const clock = new FakeClock(START);
    expect(clock.advance({ days: 1, hours: -1 }).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('sets an arbitrary instant, including backwards', () => {
    const clock = new FakeClock(START);
    clock.set(new Date('2026-10-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => new FakeClock(new Date('not a date'))).toThrow(InvalidInstantError);
    const clock = new FakeClock(START);
    expect(() => {
      clock.set(new Date(Number.NaN));
    }).toThrow(InvalidInstantError);
    expect(clock.now().getTime()).toBe(START.getTime());
  });

  it('is not affected by mutating the start date or a returned date', () => {
    const start = new Date(START);
    const clock = new FakeClock(start);
    start.setUTCFullYear(2000);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });
});
