import { describe, expect, it } from 'vitest';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import { Catalog } from '../catalog.ts';
import { decidePatientContact, isLowConfidenceCase } from './policy.ts';

const now = new Date('2026-03-01T00:00:00.000Z');
const allowed = {
  clinicAllowsContact: true,
  patientOptedOut: false,
  lowConfidence: false,
  now,
  windowDays: 14,
};

describe('decidePatientContact', () => {
  it('allows a first contact and denies for each rule, in order', () => {
    expect(decidePatientContact(allowed)).toEqual({ allowed: true });
    expect(decidePatientContact({ ...allowed, clinicAllowsContact: false })).toEqual({
      allowed: false,
      reason: 'clinic_disallows_contact',
    });
    expect(decidePatientContact({ ...allowed, patientOptedOut: true })).toMatchObject({
      reason: 'patient_opted_out',
    });
    expect(decidePatientContact({ ...allowed, backfill: true })).toMatchObject({
      reason: 'backfill_case',
    });
    expect(decidePatientContact({ ...allowed, lowConfidence: true })).toMatchObject({
      reason: 'low_confidence',
    });
    expect(
      decidePatientContact({ ...allowed, lastContactAt: new Date('2026-02-20T00:00:00.000Z') }),
    ).toMatchObject({ reason: 'contact_window' });
    expect(
      decidePatientContact({ ...allowed, lastContactAt: new Date('2026-02-15T00:00:00.000Z') }),
    ).toEqual({ allowed: true });
  });
});

describe('isLowConfidenceCase', () => {
  const catalog = new Catalog(
    [],
    [
      {
        id: 'diabetes',
        version: '1.0.0',
        description: 'd',
        reason: { code: 'protocol_diabetes', label: 'Control de diabetes' },
        enrollment: { conditionCodes: ['E11', 'E14'], minimumStatus: 'probable' },
        items: [
          {
            key: 'visit',
            kind: 'follow_up_visit',
            reason: { code: 'protocol_diabetes_visit', label: 'Control' },
            everyDays: 180,
            fulfilledBy: [{ event: 'encounter.finished', match: 'any' }],
            priority: 40,
            suggestedAction: { code: 'schedule', label: 'Agendar' },
          },
        ],
        escalationPolicy: { steps: [{ afterDays: 0, action: 'notify_clinic' }] },
      },
    ],
  );
  const protocolReason = { layer: 'protocol', protocolId: 'diabetes' } as Expectation;
  const condition = (status: PatientCondition['status']): PatientCondition =>
    ({ code: { system: ICD10_SYSTEM, code: 'E11.9' }, status }) as PatientCondition;

  it('is low confidence only when every reason rests on a probable protocol condition', () => {
    expect(isLowConfidenceCase([protocolReason], [condition('probable')], catalog)).toBe(true);
    expect(isLowConfidenceCase([protocolReason], [condition('confirmed')], catalog)).toBe(false);
    expect(
      isLowConfidenceCase(
        [protocolReason, { layer: 'universal' } as Expectation],
        [condition('probable')],
        catalog,
      ),
    ).toBe(false);
    expect(isLowConfidenceCase([], [], catalog)).toBe(false);
    expect(
      isLowConfidenceCase(
        [{ layer: 'protocol', protocolId: 'retired' } as Expectation],
        [],
        catalog,
      ),
    ).toBe(true);
  });
});
