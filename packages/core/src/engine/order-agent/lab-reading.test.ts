import { describe, expect, it } from 'vitest';
import { codeLabReading, interpretationOfRange, nameOnReport } from './lab-reading.ts';

describe('codeLabReading (a photo or PDF report, coded like the agent codes it)', () => {
  it('codes each printed test to its LOINC group and computes H/L/N from the printed range', () => {
    const coded = codeLabReading({
      isLabReport: true,
      tests: [
        { name: 'Hemoglobina glicosilada (HbA1c)', value: 8.4, unit: '%', referenceHigh: 5.6 },
        { name: 'Creatinina', value: 0.5, unit: 'mg/dL', referenceLow: 0.6, referenceHigh: 1.2 },
        { name: 'Prueba inventada XYZ', value: 3 },
        { name: 'HbA1c (repetida)', value: 9.9, unit: '%' },
      ],
    });
    expect(
      coded.results.map((result) => [result.test, result.code.code, result.interpretation]),
    ).toEqual([
      ['HbA1c', '4548-4', 'H'],
      ['creatinine', '2160-0', 'L'],
    ]);
    // Never guessed: an unknown name is reported, a group read twice keeps its first value.
    expect(coded.unrecognized).toEqual(['Prueba inventada XYZ']);
    expect(coded.results[0]?.reading.value).toBe(8.4);
  });

  it('codes nothing from something that is not a lab report', () => {
    expect(codeLabReading({ isLabReport: false, tests: [{ name: 'HbA1c', value: 8 }] })).toEqual({
      results: [],
      unrecognized: [],
    });
  });

  it('leaves the interpretation out when no range was printed', () => {
    expect(interpretationOfRange({ name: 'HbA1c', value: 8 })).toBeUndefined();
    expect(
      interpretationOfRange({ name: 'HbA1c', value: 5, referenceLow: 4, referenceHigh: 5.6 }),
    ).toBe('N');
  });
});

describe('nameOnReport (the printed name against the record; errs toward holding)', () => {
  const RECORD = 'María Fernanda Rojas Quintero';

  it.each([
    ['accents: Maria vs María', 'Maria Fernanda Rojas Quintero', RECORD],
    ['one surname vs two', 'María Rojas', RECORD],
    ['two surnames vs one', 'María Rojas Quintero', 'María Rojas'],
    ['swapped surname order', 'María Fernanda Quintero Rojas', RECORD],
    ['surname first, with a comma', 'Rojas Quintero, María Fernanda', RECORD],
    ['a middle initial', 'María F. Rojas', RECORD],
    ['a middle name the record lacks', 'María Fernanda Rojas', 'María Rojas'],
    ['extra whitespace', '  María    Fernanda   Rojas  ', RECORD],
    ['case', 'MARIA FERNANDA ROJAS', RECORD],
  ])('matches: %s', (_case, printed, record) => {
    expect(nameOnReport(printed, record)).toBe('matches');
  });

  it.each([
    ['same first name, different surname', 'María Pérez', RECORD],
    ['a common surname, different first name', 'Carlos Rojas', RECORD],
    ['near miss: María Rojas vs Mariana Rojas', 'Mariana Rojas', 'María Rojas'],
    ['an initial that is none of the record’s names', 'María X. Rojas', RECORD],
    ['only an initial and a surname (too little to be sure)', 'M. Rojas', RECORD],
    ['someone else entirely', 'Laura Beatriz Ortega', RECORD],
  ])('holds: %s', (_case, printed, record) => {
    expect(nameOnReport(printed, record)).toBe('mismatch');
  });

  it('is absent when nothing is printed (nothing to compare)', () => {
    expect(nameOnReport(undefined, RECORD)).toBe('absent');
    expect(nameOnReport('   ', RECORD)).toBe('absent');
  });
});
