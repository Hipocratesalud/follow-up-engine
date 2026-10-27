import { describe, expect, it } from 'vitest';
import {
  addInterval,
  addUtcMonths,
  daysBetween,
  durationInDays,
  parseIsoDate,
  resolveDueAt,
} from './due-date.ts';

const authoredAt = new Date('2025-03-10T12:00:00Z');
const relative = (amount: number, unit: 'day' | 'week' | 'month' | 'year') => ({
  amount,
  unit,
  date: null,
});

describe('resolveDueAt', () => {
  it('"ctrl en 3 meses" is three calendar months after the note', () => {
    const r = resolveDueAt(authoredAt, relative(3, 'month'));
    expect(r).toEqual({ ok: true, dueAt: new Date('2025-06-10T12:00:00Z') });
  });

  it('"en 15 días" is exactly 15 days later', () => {
    const r = resolveDueAt(authoredAt, relative(15, 'day'));
    expect(r).toEqual({ ok: true, dueAt: new Date('2025-03-25T12:00:00Z') });
  });

  it('"en 6 semanas" is 42 days later', () => {
    const r = resolveDueAt(authoredAt, relative(6, 'week'));
    expect(r.ok && daysBetween(authoredAt, r.dueAt)).toBe(42);
  });

  it('"próximo mes" (amount 1, month) is one calendar month later', () => {
    const r = resolveDueAt(authoredAt, relative(1, 'month'));
    expect(r).toEqual({ ok: true, dueAt: new Date('2025-04-10T12:00:00Z') });
  });

  it('"en 1 año" is twelve calendar months later', () => {
    const r = resolveDueAt(authoredAt, relative(1, 'year'));
    expect(r).toEqual({ ok: true, dueAt: new Date('2026-03-10T12:00:00Z') });
  });

  it('an explicit date is used as is, at noon UTC', () => {
    const r = resolveDueAt(authoredAt, { amount: null, unit: null, date: '2025-03-24' });
    expect(r).toEqual({ ok: true, dueAt: new Date('2025-03-24T12:00:00Z') });
  });

  it('an explicit date wins over a relative interval', () => {
    const r = resolveDueAt(authoredAt, { amount: 3, unit: 'month', date: '2025-04-01' });
    expect(r.ok && r.dueAt.toISOString()).toBe('2025-04-01T12:00:00.000Z');
  });

  it('an explicit date on the note day is accepted, one before it is rejected', () => {
    expect(resolveDueAt(authoredAt, { amount: null, unit: null, date: '2025-03-10' }).ok).toBe(
      true,
    );
    expect(resolveDueAt(authoredAt, { amount: null, unit: null, date: '2025-03-09' })).toEqual({
      ok: false,
      reason: 'due_before_note',
    });
  });

  it('no timing, a zero or negative amount, or an invalid date mean no due date', () => {
    expect(resolveDueAt(authoredAt, null)).toEqual({ ok: false, reason: 'no_due_date' });
    expect(resolveDueAt(authoredAt, { amount: 0, unit: 'day', date: null }).ok).toBe(false);
    expect(resolveDueAt(authoredAt, { amount: -2, unit: 'day', date: null }).ok).toBe(false);
    expect(resolveDueAt(authoredAt, { amount: 3, unit: null, date: null }).ok).toBe(false);
    expect(resolveDueAt(authoredAt, { amount: null, unit: null, date: '2025-02-30' }).ok).toBe(
      false,
    );
  });

  it('falls back to the relative interval when the date is malformed', () => {
    const r = resolveDueAt(authoredAt, { amount: 2, unit: 'week', date: 'next tuesday' });
    expect(r.ok && daysBetween(authoredAt, r.dueAt)).toBe(14);
  });
});

describe('date arithmetic', () => {
  it('clamps to the end of shorter months', () => {
    expect(addUtcMonths(new Date('2025-01-31T09:00:00Z'), 1)).toEqual(
      new Date('2025-02-28T09:00:00Z'),
    );
    expect(addUtcMonths(new Date('2024-01-31T09:00:00Z'), 1)).toEqual(
      new Date('2024-02-29T09:00:00Z'),
    );
    expect(addUtcMonths(new Date('2025-11-15T09:00:00Z'), 3)).toEqual(
      new Date('2026-02-15T09:00:00Z'),
    );
  });

  it('uses 30-day months for fractional months ("mes y medio")', () => {
    expect(daysBetween(authoredAt, addInterval(authoredAt, 1.5, 'month'))).toBe(45);
  });

  it('converts treatment durations to days', () => {
    expect(durationInDays(7, 'day')).toBe(7);
    expect(durationInDays(2, 'week')).toBe(14);
    expect(durationInDays(3, 'month')).toBe(90);
  });

  it('parses only real YYYY-MM-DD dates', () => {
    expect(parseIsoDate('2025-12-31')).toEqual(new Date('2025-12-31T12:00:00Z'));
    expect(parseIsoDate('2025-13-01')).toBeUndefined();
    expect(parseIsoDate('31/12/2025')).toBeUndefined();
  });
});
