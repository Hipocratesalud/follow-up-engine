import { type CaseEvent, caseId, clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
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

describe('closed reason labels', () => {
  it.each(ENGINE_CLOSED_REASONS)('%s has Spanish copy', (reason) => {
    const label = closedReasonLabel(reason);
    expect(label).toBeDefined();
    expect(label).not.toMatch(/_/);
  });

  it('names why the engine closed a case on its own', () => {
    expect(
      timelineLabel(
        resolvedBySystem(['patient_discharged', 'patient_discharged']),
        () => '',
        () => '',
      ),
    ).toBe('Cerrado: ya no hace falta (el médico dio de alta al paciente)');
    expect(
      timelineLabel(
        resolvedBySystem(['source_withdrawn']),
        () => '',
        () => '',
      ),
    ).toBe('Cerrado: ya no hace falta (el registro que la originó fue anulado o retirado)');
  });

  it('keeps the bare resolution when the reason has no copy', () => {
    expect(
      timelineLabel(
        resolvedBySystem(['something_new']),
        () => '',
        () => '',
      ),
    ).toBe('Cerrado: ya no hace falta');
  });
});
