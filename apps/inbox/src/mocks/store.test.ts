import { describe, expect, it } from 'vitest';
import { MockHttpError, createMockStore } from './store.ts';

function expectHttpError(run: () => unknown, status: number, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MockHttpError);
    expect(error).toMatchObject({ status, code });
    return;
  }
  throw new Error('expected an error');
}

describe('mock store', () => {
  it('lists active cases by priority with all reasons merged per patient', () => {
    const store = createMockStore();
    const { items } = store.listCases({ view: 'active' });
    expect(items.length).toBeGreaterThan(10);
    const priorities = items.map((item) => item.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    const patientIds = items.map((item) => item.patient.id);
    expect(new Set(patientIds).size).toBe(patientIds.length);
    expect(items.every((item) => item.origin === 'live' || !item.releaseAt)).toBe(true);
  });

  it('rejects actions on a closed case with 409', () => {
    const store = createMockStore();
    store.act('case-001', { action: 'resolve' });
    expect(store.getCase('case-001').status).toBe('resolved');
    expectHttpError(() => store.act('case-001', { action: 'notify' }), 409, 'invalid_transition');
  });

  it('refuses to contact a patient who opted out', () => {
    const store = createMockStore();
    const optedOut = store
      .listCases({ view: 'active' })
      .items.find((item) => item.patientContact.optedOut);
    expect(optedOut).toBeDefined();
    expectHttpError(
      () => store.act(optedOut?.id ?? '', { action: 'notify' }),
      409,
      'patient_contact_not_allowed',
    );
  });

  it('requires a reason when feedback is not useful', () => {
    const store = createMockStore();
    expectHttpError(
      () => store.feedback('case-001', { useful: false }),
      422,
      'feedback_reason_required',
    );
    expect(store.feedback('case-001', { useful: false, reason: 'wrong_interval' })).toEqual({
      useful: false,
      reason: 'wrong_interval',
    });
  });

  it('opens new cases, releases backfill and escalates when the clock advances', () => {
    const store = createMockStore();
    const before = store.stats().activeCases;
    const recoveryBefore = store.listRecovery({}).total;
    const webhooksBefore = store.listWebhooks(100).items.length;

    store.advance(30);

    expect(store.stats().activeCases).toBeGreaterThan(before);
    expect(store.listRecovery({}).total).toBeLessThan(recoveryBefore);
    const types = store.listWebhooks(100).items.map((item) => item.type);
    expect(types.length).toBeGreaterThan(webhooksBefore);
    expect(types).toContain('case.opened');
    expect(types).toContain('case.escalated');
  });

  it('turns a demo consultation into expectations that later open a case with the quote', () => {
    const store = createMockStore();
    const response = store.createConsultation({
      patientName: 'Paciente de Prueba',
      specialty: 'psychology',
      noteText:
        'Consultante con crisis de angustia recurrentes. Plan: próxima sesión en 2 semanas.',
    });
    expect(response.extraction.planItems[0]?.evidenceQuote).toBe('próxima sesión en 2 semanas');
    expect(response.expectationsCreated.map((expectation) => expectation.layer)).toEqual([
      'doctor_plan',
    ]);

    store.advance(15);
    const opened = store
      .listCases({ view: 'active' })
      .items.find((item) => item.patient.name === 'Paciente de Prueba');
    expect(opened?.reasons[0]?.evidence?.quote).toBe('próxima sesión en 2 semanas');
  });
});
