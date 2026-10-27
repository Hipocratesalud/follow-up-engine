import { type CaseEvent, caseId, clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { API_LOCALES, messagesFor } from '../i18n/index.ts';
import { closedReasonLabel, timelineLabel } from './labels.ts';

/** Every `Expectation.closedReason` the engine writes when it closes on its own. */
const ENGINE_CLOSED_REASONS = [
  'fulfilled_by_result',
  'fulfilled_by_encounter',
  'fulfilled_by_appointment',
  'superseded_by_new_order',
  'source_withdrawn',
  'superseded_by_amended_note',
  'patient_discharged',
  'conditional_return',
  'covered_by_plan',
  'covered_by_later_request',
  'condition_rejected',
  'protocol_closed',
  'pregnancy_ended',
  'rescheduled_by_protocol',
  'suppressed_for_patient',
];

function resolvedBySystem(closedReasons: readonly string[]): CaseEvent {
  return {
    id: 'ev-1',
    clinicId: clinicId('clinic-demo'),
    caseId: caseId('case-1'),
    type: 'resolved',
    actor: { type: 'rule', id: 'cadence_break' },
    at: new Date('2026-02-01T00:00:00Z'),
    payload: { kind: 'not_needed', closedReasons: [...closedReasons] },
  } as CaseEvent;
}

const EN = messagesFor('en');
const ES = messagesFor('es');

describe('closed reason labels', () => {
  it.each(API_LOCALES.flatMap((locale) => ENGINE_CLOSED_REASONS.map((r) => [locale, r] as const)))(
    '%s: %s has copy',
    (locale, reason) => {
      const label = closedReasonLabel(messagesFor(locale), reason);
      expect(label).toBeDefined();
      expect(label).not.toMatch(/_/);
    },
  );

  it('names why the engine closed a case on its own', () => {
    const discharged = resolvedBySystem(['patient_discharged', 'patient_discharged']);
    expect(
      timelineLabel(
        EN,
        discharged,
        () => '',
        () => '',
      ),
    ).toBe('Closed: no longer needed (the doctor discharged the patient)');
    expect(
      timelineLabel(
        ES,
        discharged,
        () => '',
        () => '',
      ),
    ).toBe('Cerrado: ya no hace falta (el médico dio de alta al paciente)');
    expect(
      timelineLabel(
        ES,
        resolvedBySystem(['source_withdrawn']),
        () => '',
        () => '',
      ),
    ).toBe('Cerrado: ya no hace falta (el registro que la originó fue anulado o retirado)');
  });

  it('keeps the bare resolution when the reason has no copy', () => {
    expect(
      timelineLabel(
        EN,
        resolvedBySystem(['something_new']),
        () => '',
        () => '',
      ),
    ).toBe('Closed: no longer needed');
  });
});
