import type { Expectation, ExpectationLayer, PatientCondition } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { messagesFor } from '../i18n/index.ts';
import { sourceDisplay } from './fhir-display.ts';
import { byActionability, withoutConfirmedDuplicates } from './presenter.ts';
import { icd10Label } from './terminology.ts';

function expectation(id: string, ruleId: string, layer: ExpectationLayer, dueAt: string) {
  return { id, ruleId, layer, dueAt: new Date(dueAt) } as unknown as Expectation;
}

describe('case reasons', () => {
  it('put the most actionable first: abnormal result, pending result, plan, cadence, protocol', () => {
    const reasons = [
      expectation('a', 'protocol_diabetes_fundus', 'protocol', '2025-01-01'),
      expectation('b', 'cadence_break', 'cadence', '2025-02-01'),
      expectation('c', 'doctor_plan_followup', 'doctor_plan', '2025-03-01'),
      expectation('d', 'lab_order_result_pending', 'universal', '2025-04-01'),
      expectation('e', 'abnormal_result_followup', 'universal', '2025-05-01'),
      expectation('f', 'short_treatment_followup', 'universal', '2025-01-15'),
    ];
    expect(byActionability(reasons).map((reason) => reason.id)).toEqual([
      'e',
      'd',
      'c',
      'f',
      'b',
      'a',
    ]);
  });

  it('break ties by the longest overdue', () => {
    const reasons = [
      expectation('late', 'protocol_diabetes_hba1c', 'protocol', '2025-06-01'),
      expectation('early', 'protocol_diabetes_fundus', 'protocol', '2025-01-01'),
    ];
    expect(byActionability(reasons).map((reason) => reason.id)).toEqual(['early', 'late']);
  });
});

const EN = messagesFor('en');
const ES = messagesFor('es');

const HBA1C_OBSERVATION = {
  resourceType: 'Observation',
  id: 'obs-1',
  code: {
    coding: [
      {
        system: 'http://loinc.org',
        code: '4548-4',
        display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
      },
    ],
  },
};

describe('displays in the request language', () => {
  it('name known LOINC codes in the catalog language when the host sent no text', () => {
    expect(sourceDisplay(EN, 'Observation', HBA1C_OBSERVATION)).toBe('Hemoglobin A1c (HbA1c)');
    expect(sourceDisplay(ES, 'Observation', HBA1C_OBSERVATION)).toBe(
      'Hemoglobina glicosilada (HbA1c)',
    );
  });

  it('date a source without a name in the catalog language', () => {
    const note = { resourceType: 'DocumentReference', id: 'n-1', date: '2026-01-05T10:00:00Z' };
    expect(sourceDisplay(EN, 'DocumentReference', note)).toBe('Clinical note of January 5, 2026');
    expect(sourceDisplay(ES, 'DocumentReference', note)).toBe(
      'Nota clínica del 5 de enero de 2026',
    );
  });

  it("keep the host's own text, and fall back to the coding display for unknown codes", () => {
    expect(
      sourceDisplay(EN, 'ServiceRequest', {
        resourceType: 'ServiceRequest',
        id: 'sr-1',
        code: { text: 'HbA1c de control', coding: [{ code: '4548-4' }] },
      }),
    ).toBe('HbA1c de control');
    expect(
      sourceDisplay(EN, 'ServiceRequest', {
        resourceType: 'ServiceRequest',
        id: 'sr-2',
        code: { coding: [{ code: '99999-9', display: 'Something else' }] },
      }),
    ).toBe('Something else');
  });

  it("name ICD-10 conditions from the catalog before the host's display", () => {
    expect(icd10Label(ES, 'E11.9', 'Type 2 diabetes mellitus without complications')).toBe(
      'Diabetes mellitus tipo 2',
    );
    expect(icd10Label(EN, 'E11.9', 'T2DM w/o complications')).toBe('Type 2 diabetes mellitus');
    expect(icd10Label(ES, 'F41.0', 'Panic disorder')).toBe('Trastorno de pánico');
    expect(icd10Label(EN, 'Q99.9', 'Unknown thing')).toBe('Unknown thing');
  });
});

describe('patient conditions', () => {
  it('hide a probable condition the record already confirms in the same category', () => {
    const condition = (code: string, status: PatientCondition['status']) =>
      ({ code: { system: 'icd10', code }, status }) as unknown as PatientCondition;
    const kept = withoutConfirmedDuplicates([
      condition('E11', 'probable'),
      condition('E11.9', 'confirmed'),
      condition('I10', 'probable'),
    ]);
    expect(kept.map((item) => item.code.code)).toEqual(['E11.9', 'I10']);
  });
});
