import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ClinicId,
  clinicId,
  InvalidIdentifierError,
  type PatientId,
  patientId,
} from './ids.ts';

describe('identifiers', () => {
  it('accepts non-empty trimmed strings', () => {
    expect(clinicId('clinic-1')).toBe('clinic-1');
  });

  it.each(['', ' clinic-1', 'clinic-1 '])('rejects %j', (raw) => {
    expect(() => clinicId(raw)).toThrow(InvalidIdentifierError);
  });

  it('keeps ids of different kinds apart at compile time', () => {
    expectTypeOf(clinicId('a')).toEqualTypeOf<ClinicId>();
    expectTypeOf(patientId('a')).not.toEqualTypeOf<ClinicId>();
    expectTypeOf<PatientId>().not.toExtend<ClinicId>();
  });
});
