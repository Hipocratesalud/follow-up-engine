import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CASE_STATUSES, ActiveCaseStatus, CaseStatus } from './case.ts';
import type {
  CLINICAL_EVENT_TYPES,
  ClinicalEvent,
  ClinicalEventOf,
  ClinicalEventType,
} from './clinical-event.ts';
import type {
  DOMAIN_EVENT_TYPES,
  DomainEvent,
  DomainEventType,
  PatientContactRequestedPayload,
} from './domain-event.ts';

/** Exhaustive switch: adding an event type without handling it fails to compile. */
function describeEvent(event: ClinicalEvent): string {
  switch (event.type) {
    case 'encounter.finished':
      return event.specialty ?? 'encounter';
    case 'appointment.booked':
    case 'appointment.cancelled':
      return event.scheduledFor.toISOString();
    case 'service_request.created':
      return `${event.category}:${event.orderId}`;
    case 'result.received':
      return event.interpretation;
    case 'medication.prescribed':
      return event.medication.text;
    case 'condition.recorded':
      return event.code.code;
    case 'note.received':
      return event.documentId;
    case 'plan.extracted':
      return String(event.items.length);
    case 'patient.opted_out':
      return 'opted out';
    case 'patient.language_recorded':
      return event.language ?? 'no language';
    case 'record.withdrawn':
      return event.reason;
  }
}

describe('domain contract', () => {
  it('keeps runtime type lists and unions in sync', () => {
    expectTypeOf<(typeof CLINICAL_EVENT_TYPES)[number]>().toEqualTypeOf<ClinicalEvent['type']>();
    expectTypeOf<(typeof DOMAIN_EVENT_TYPES)[number]>().toEqualTypeOf<DomainEvent['type']>();
    expectTypeOf<(typeof CASE_STATUSES)[number]>().toEqualTypeOf<CaseStatus>();
    expectTypeOf<ActiveCaseStatus>().toExtend<CaseStatus>();
    expectTypeOf<ClinicalEventType>().toEqualTypeOf<ClinicalEvent['type']>();
    expectTypeOf<DomainEventType>().toEqualTypeOf<DomainEvent['type']>();
  });

  it('narrows clinical events by type', () => {
    expectTypeOf<ClinicalEventOf<'result.received'>['basedOnOrderId']>().toEqualTypeOf<
      string | undefined
    >();
    expect(
      describeEvent({
        type: 'patient.opted_out',
        clinicId: 'c' as ClinicalEvent['clinicId'],
        patientId: 'p' as ClinicalEvent['patientId'],
        source: { resourceType: 'Consent', id: '1' },
        occurredAt: new Date(0),
        idempotencyKey: 'Consent/1/1#patient.opted_out',
      }),
    ).toBe('opted out');
  });

  it('keeps patient contact requests free of clinical content', () => {
    // `language` is the patient's preferred language (BCP-47), not clinical content.
    expectTypeOf<keyof PatientContactRequestedPayload>().toEqualTypeOf<
      'caseId' | 'patientId' | 'purpose' | 'dueBy' | 'language'
    >();
  });
});
