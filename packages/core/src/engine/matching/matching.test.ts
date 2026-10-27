import { describe, expect, it } from 'vitest';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import { matchesFilter, readPath } from './filter.ts';
import { codeMatchKey, kindOfMatchKey, matchKeyFor, parseCodeMatchKey } from './match-key.ts';

describe('matchesFilter', () => {
  const event = { category: 'Laboratory', code: { code: '4548-4' }, durationDays: 7, flag: true };

  it('matches literals case-insensitively, lists and nested paths', () => {
    expect(matchesFilter(undefined, event)).toBe(true);
    expect(matchesFilter({ category: 'laboratory' }, event)).toBe(true);
    expect(matchesFilter({ 'code.code': ['2160-0', '4548-4'] }, event)).toBe(true);
    expect(matchesFilter({ 'code.code': '2160-0' }, event)).toBe(false);
    expect(matchesFilter({ flag: true, durationDays: 7 }, event)).toBe(true);
  });

  it('supports numeric bounds and presence checks', () => {
    expect(matchesFilter({ durationDays: { lte: 30, gt: 0 } }, event)).toBe(true);
    expect(matchesFilter({ durationDays: { lt: 7 } }, event)).toBe(false);
    expect(matchesFilter({ durationDays: { gte: 8 } }, event)).toBe(false);
    expect(matchesFilter({ category: { lte: 3 } }, event)).toBe(false);
    expect(matchesFilter({ missing: { exists: false } }, event)).toBe(true);
    expect(matchesFilter({ durationDays: { exists: true } }, event)).toBe(true);
    expect(matchesFilter({ missing: { exists: true } }, event)).toBe(false);
  });

  it('reads dot paths defensively', () => {
    expect(readPath(event, 'code.code')).toBe('4548-4');
    expect(readPath(event, 'code.code.deeper')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('match keys', () => {
  it('encodes well-known systems with a short alias and others generically, both reversibly', () => {
    expect(codeMatchKey({ system: 'http://loinc.org', code: '4548-4' })).toBe('loinc:4548-4');
    expect(codeMatchKey({ system: ICD10_SYSTEM, code: 'E11' })).toBe('icd10:E11');
    const custom = { system: 'https://example.org/cs', code: 'fundus-exam' };
    expect(codeMatchKey(custom)).toBe('code:https://example.org/cs|fundus-exam');
    expect(parseCodeMatchKey(codeMatchKey(custom))).toEqual(custom);
    expect(parseCodeMatchKey('loinc:4548-4')).toEqual({
      system: 'http://loinc.org',
      code: '4548-4',
    });
    expect(parseCodeMatchKey('visit')).toBeUndefined();
    expect(parseCodeMatchKey('unknown:1')).toBeUndefined();
    expect(parseCodeMatchKey('code:nobar')).toBeUndefined();
  });

  it('derives keys from kinds and back', () => {
    expect(matchKeyFor('follow_up_visit', undefined)).toBe('visit');
    expect(matchKeyFor('lab', undefined)).toBe('lab');
    expect(matchKeyFor('imaging', { system: 'http://loinc.org', code: '36643-5' })).toBe(
      'loinc:36643-5',
    );
    expect(matchKeyFor('session', { system: 'http://loinc.org', code: 'x' })).toBe('session');
    expect(kindOfMatchKey('visit')).toBe('follow_up_visit');
    expect(kindOfMatchKey('session')).toBe('session');
    expect(kindOfMatchKey('loinc:4548-4')).toBe('lab');
  });
});
