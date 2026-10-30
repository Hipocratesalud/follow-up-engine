import { describe, expect, it } from 'vitest';
import { codeLabReading, interpretationOfRange } from './lab-reading.ts';

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
