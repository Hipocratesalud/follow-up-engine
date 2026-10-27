import { describe, expect, it } from 'vitest';
import { daysBetween, durationToDays, firstDate, parseFhirDateTime } from './datetime.ts';

describe('parseFhirDateTime', () => {
  it.each([
    ['2026', '2026-01-01T00:00:00.000Z'],
    ['2026-03', '2026-03-01T00:00:00.000Z'],
    ['2026-03-09', '2026-03-09T00:00:00.000Z'],
    ['2026-03-09T10:15:00-04:00', '2026-03-09T14:15:00.000Z'],
    ['2026-03-09T10:15:00.250Z', '2026-03-09T10:15:00.250Z'],
  ])('reads %s as the start of the period it denotes', (raw, iso) => {
    expect(parseFhirDateTime(raw)?.toISOString()).toBe(iso);
  });

  it.each(['05/01/2026', '2026-13-01', '2026-03-09T10:15:00', '', 'yesterday'])(
    'rejects %j (not a FHIR dateTime; a time needs a zone)',
    (raw) => {
      expect(parseFhirDateTime(raw)).toBeUndefined();
    },
  );

  it('takes the first parseable candidate', () => {
    expect(firstDate(undefined, 'nope', '2026-01-02')?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(firstDate(undefined)).toBeUndefined();
  });
});

describe('durationToDays', () => {
  it.each([
    [{ value: 90, code: 'd' }, 90],
    [{ value: 4, code: 'wk' }, 28],
    [{ value: 3, code: 'mo' }, 90],
    [{ value: 1, code: 'a' }, 365],
    [{ value: 36, code: 'h' }, 2],
    [{ value: 2, unit: 'semanas' }, 14],
    [{ value: 30, unit: 'days' }, 30],
  ])('converts %j to %i days (UCUM code first, then free-text unit)', (duration, days) => {
    expect(durationToDays(duration)).toBe(days);
  });

  it.each([undefined, { value: 0, code: 'd' }, { value: 5, code: 'furlongs' }, { code: 'd' }])(
    'returns undefined for %j',
    (duration) => {
      expect(durationToDays(duration)).toBeUndefined();
    },
  );

  it('ignores prototype keys used as units', () => {
    expect(durationToDays({ value: 1, unit: 'constructor' })).toBeUndefined();
  });
});

describe('daysBetween', () => {
  it('rounds partial days up and never goes negative', () => {
    expect(daysBetween(new Date('2026-01-01T00:00Z'), new Date('2026-01-06T01:00Z'))).toBe(6);
    expect(daysBetween(new Date('2026-01-06'), new Date('2026-01-01'))).toBe(0);
  });
});
