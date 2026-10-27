import {
  type CaseId,
  caseId as toCaseId,
  type DomainEvent,
  InvalidCaseTransitionError,
  NotFoundError,
  ValidationError,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  CODES,
  consultation,
  defined,
  icd10,
  patientOptedOut,
  scenario,
  type ScenarioWorld,
} from '../testing/index.ts';

const USER = { type: 'user', id: 'nurse-ana' } as const;

async function onlyCaseId(world: ScenarioWorld, patient?: string): Promise<CaseId> {
  const [followUpCase] = await world.activeCases(patient);
  if (followUpCase === undefined) {
    throw new Error('expected an active case');
  }
  return followUpCase.id;
}

function contactRequests(world: ScenarioWorld): DomainEvent[] {
  return world.outbox().filter((event) => event.type === 'patient_contact.requested');
}

/** A lab order whose result never arrives: a case at day 16. */
function pendingLabCase(options: { allowPatientContact?: boolean } = {}) {
  return scenario({ allowPatientContact: options.allowPatientContact ?? true })
    .at(0)
    .consult({
      encounterId: 'enc-1',
      practitionerId: 'dr-rivas',
      labs: [{ id: 'sr-1', code: CODES.hba1c }],
    })
    .at(16)
    .runWatcher();
}

describe('escalation default_v1', () => {
  it('notifies once, raises priority and asks for patient contact at day 14, then coordinator, then lost to follow-up', async () => {
    const world = await pendingLabCase()
      .runEscalation()
      .expectCases([{ status: 'notified', assignee: 'dr-rivas' }])
      .at(29)
      .runEscalation()
      .check((current) => {
        expect(contactRequests(current)).toHaveLength(0);
      })
      .at(30)
      .runEscalation()
      .check((current) => {
        expect(contactRequests(current)).toHaveLength(1);
        expect(contactRequests(current)[0]?.payload).toEqual({
          caseId: expect.any(String) as string,
          patientId: 'pat-1',
          purpose: 'complete_pending_test',
          dueBy: current.dayAt(37),
        });
      })
      .at(37)
      .runEscalation()
      .expectCases([{ status: 'escalated', assignee: 'coordinator' }])
      .at(51)
      .runEscalation()
      .expectNoCases()
      .run();

    const [lost] = await world.cases();
    expect(lost?.status).toBe('lost_to_follow_up');
    expect(lost?.resolution?.kind).toBe('patient_unreachable');
    const audit = await world.audit(defined(lost).id);
    expect(audit.map((event) => `${event.type}:${event.actor.type}`)).toEqual([
      'opened:rule',
      'notified:system',
      'escalated:system',
      'patient_contact_requested:system',
      'escalated:system',
      'lost_to_follow_up:system',
    ]);
    expect(world.outbox().map((event) => event.type)).toEqual([
      'case.opened',
      'case.escalated',
      'patient_contact.requested',
      'case.escalated',
      'case.resolved',
    ]);
    const opened = world.outbox().find((event) => event.type === 'case.opened');
    const raised = world.outbox().find((event) => event.type === 'case.escalated');
    expect(opened?.type === 'case.opened' && raised?.type === 'case.escalated').toBe(true);
    if (opened?.type === 'case.opened' && raised?.type === 'case.escalated') {
      expect(raised.payload.priority).toBe(opened.payload.priority + 20);
    }
  });

  it('a daily cron reaches the same outcome as targeted runs', async () => {
    const world = await pendingLabCase().daily(30).run();
    expect(contactRequests(world)).toHaveLength(1);
    expect((await world.cases())[0]?.status).toBe('escalated');
  });

  it('the patient coming back resolves an escalated case', async () => {
    await pendingLabCase()
      .runEscalation()
      .at(38)
      .runEscalation()
      .expectCases([{ status: 'escalated' }])
      .ingest((world) => [
        {
          type: 'result.received',
          clinicId: world.clinicId,
          patientId: world.patientId,
          source: { resourceType: 'Observation', id: 'obs-1' },
          occurredAt: world.clock.now(),
          idempotencyKey: 'Observation/obs-1/1#result.received',
          basedOnOrderId: 'sr-1',
          code: CODES.hba1c,
          interpretation: 'normal',
        },
      ])
      .expectNoCases()
      .run();
  });
});

describe('patient contact rules', () => {
  it('asks once per patient per window even with two cases escalating the same day', async () => {
    const world = await scenario({ allowPatientContact: true })
      .at(0)
      .consult({
        encounterId: 'enc-1',
        labs: [{ id: 'sr-1', code: CODES.hba1c }],
        medications: [{ id: 'mr-1', text: 'amoxicilina 500 mg', durationDays: 12 }],
      })
      .at(16)
      .runWatcher()
      .expectCases([
        { reasons: ['lab_order_result_pending'] },
        { reasons: ['short_treatment_followup'] },
      ])
      .runEscalation()
      .at(30)
      .runEscalation()
      .run();
    expect(contactRequests(world)).toHaveLength(1);
    expect(world.lastEscalation?.contactsSkipped.map((skip) => skip.reason)).toEqual([
      'contact_window',
    ]);
  });

  it('an opt-out stops patient contact only: the case goes on and escalates straight to the coordinator', async () => {
    const world = await pendingLabCase()
      .runEscalation()
      .at(20)
      .ingest((current) => [patientOptedOut(current.context(), { id: 'consent-1' })])
      .expectCases([{ reasons: ['lab_order_result_pending'], status: 'notified' }])
      .at(30)
      .runEscalation()
      .expectCases([{ status: 'escalated', assignee: 'coordinator' }])
      .at(60)
      .consult({ encounterId: 'enc-2', labs: [{ id: 'sr-2', code: CODES.creatinine }] })
      // Follow-up goes on: the new order is expected, and so is the next visit.
      .expectOpenExpectations([
        { ruleId: 'lab_order_result_pending', dueDay: 75 },
        { ruleId: 'cadence_break', dueDay: 240 },
      ])
      .run();
    expect(contactRequests(world)).toHaveLength(0);
    expect(world.lastEscalation?.contactsSkipped.map((skip) => skip.reason)).toEqual([
      'patient_opted_out',
    ]);
    // Raise priority, contact (skipped), coordinator: all on day 30, no wait for an answer.
    expect(world.lastEscalation?.steps.map((step) => step.action)).toEqual([
      'raise_priority',
      'request_patient_contact',
      'escalate_to_coordinator',
    ]);
    const status = await world.engine.patientContactStatus(world.clinicId, world.patientId);
    expect(status).toEqual({ allowed: false, optedOut: true });
  });

  it('a user asks for patient contact: allowed once per window, never for an opted-out patient', async () => {
    const world = await pendingLabCase().run();
    const caseId = await onlyCaseId(world);
    await world.engine.cases.requestPatientContact(world.clinicId, caseId, USER);
    const [request] = contactRequests(world);
    expect(request?.payload).toMatchObject({ caseId, purpose: 'complete_pending_test' });
    const audit = await world.audit(caseId);
    expect(audit.at(-1)).toMatchObject({ type: 'patient_contact_requested', actor: USER });
    await expect(
      world.engine.cases.requestPatientContact(world.clinicId, caseId, USER),
    ).rejects.toMatchObject({ name: 'PatientContactNotAllowedError', reason: 'contact_window' });

    const optedOut = await pendingLabCase()
      .ingest((current) => [patientOptedOut(current.context(), { id: 'consent-1' })])
      .run();
    await expect(
      optedOut.engine.cases.requestPatientContact(
        optedOut.clinicId,
        await onlyCaseId(optedOut),
        USER,
      ),
    ).rejects.toMatchObject({ reason: 'patient_opted_out' });

    const closedClinic = await pendingLabCase({ allowPatientContact: false }).run();
    await expect(
      closedClinic.engine.cases.requestPatientContact(
        closedClinic.clinicId,
        await onlyCaseId(closedClinic),
        USER,
      ),
    ).rejects.toMatchObject({ reason: 'clinic_disallows_contact' });
    expect(contactRequests(optedOut)).toEqual([]);
  });

  it('never contacts the patient for a case built only on a probable condition', async () => {
    const world = await scenario({ allowPatientContact: true })
      .at(0)
      .consult({
        encounterId: 'enc-1',
        medications: [{ id: 'mr-1', text: 'Metformina 850 mg c/12h' }],
      })
      .check(async (current) => {
        const conditions = await current.harness.stores.conditions.listByPatient(
          current.clinicId,
          current.patientId,
        );
        expect(conditions).toMatchObject([
          { code: icd10('E14'), status: 'probable', sourceType: 'inferred_from_medication' },
        ]);
      })
      .at(181)
      .runWatcher()
      .expectCases([{ reasons: ['protocol_diabetes_hba1c', 'protocol_diabetes_visit'] }])
      .runEscalation()
      .at(195)
      .runEscalation()
      .run();
    expect(contactRequests(world)).toHaveLength(0);
    expect(world.lastEscalation?.contactsSkipped).toEqual([
      { caseId: await onlyCaseId(world), reason: 'low_confidence' },
    ]);
  });

  it('never contacts the patient when the clinic does not allow it', async () => {
    const world = await pendingLabCase({ allowPatientContact: false })
      .runEscalation()
      .at(30)
      .runEscalation()
      .run();
    expect(contactRequests(world)).toHaveLength(0);
    expect(world.lastEscalation?.contactsSkipped.map((skip) => skip.reason)).toEqual([
      'clinic_disallows_contact',
    ]);
  });

  it('the contact request never carries a diagnosis or a test name', async () => {
    const world = await pendingLabCase().runEscalation().at(30).runEscalation().run();
    const serialized = JSON.stringify(contactRequests(world));
    expect(serialized).not.toMatch(/4548|hba1c|E11|diab/iu);
  });
});

describe('case commands', () => {
  it('rejects an invalid transition', async () => {
    const world = await pendingLabCase().run();
    const caseId = await onlyCaseId(world);
    await world.engine.cases.resolve(world.clinicId, caseId, USER);
    await expect(
      world.engine.cases.snooze(world.clinicId, caseId, world.dayAt(40), USER),
    ).rejects.toBeInstanceOf(InvalidCaseTransitionError);
    await expect(world.engine.cases.notify(world.clinicId, caseId, USER)).rejects.toThrow(
      /cannot move from resolved to notified/u,
    );
    await expect(
      world.engine.cases.notify(world.clinicId, toCaseId('case-404'), USER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a snoozed case does not escalate and wakes up to its previous status', async () => {
    const world = await pendingLabCase()
      .runEscalation()
      .act('snooze until day 40', async (current) => {
        await current.engine.cases.snooze(
          current.clinicId,
          await onlyCaseId(current),
          current.dayAt(40),
          USER,
        );
      })
      .at(30)
      .runEscalation()
      .expectCases([{ status: 'snoozed' }])
      .at(40)
      .runEscalation()
      .expectCases([{ status: 'notified' }])
      .run();
    expect(contactRequests(world)).toHaveLength(0);
    expect(world.lastEscalation?.woken).toHaveLength(1);
    const followUpCase = (await world.activeCases())[0];
    expect(followUpCase?.nextActionAt).toEqual(world.dayAt(54));
  });

  it('snoozing to a past date is rejected', async () => {
    const world = await pendingLabCase().run();
    await expect(
      world.engine.cases.snooze(world.clinicId, await onlyCaseId(world), world.dayAt(1), USER),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('notify, assign, dismiss and resolve are audited with the user as actor', async () => {
    const world = await pendingLabCase().run();
    const caseId = await onlyCaseId(world);
    const notified = await world.engine.cases.apply(
      world.clinicId,
      caseId,
      { type: 'notify' },
      USER,
    );
    expect(notified.status).toBe('notified');
    expect(notified.nextActionAt).toEqual(world.dayAt(30));
    const assigned = await world.engine.cases.assign(world.clinicId, caseId, 'dr-mora', USER);
    expect(assigned.assignee).toBe('dr-mora');
    const dismissed = await world.engine.cases.dismiss(world.clinicId, caseId, USER, 'duplicate');
    expect(dismissed).toMatchObject({
      status: 'dismissed',
      resolution: { kind: 'not_needed', resolvedBy: 'nurse-ana' },
    });
    const audit = await world.audit(caseId);
    expect(audit.slice(1).map((event) => [event.type, event.actor])).toEqual([
      ['notified', USER],
      ['assigned', USER],
      ['dismissed', USER],
    ]);
    await expect(
      world.engine.cases.assign(world.clinicId, caseId, 'dr-mora', USER),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a user resolution is recorded with its kind', async () => {
    const world = await pendingLabCase().run();
    const resolved = await world.engine.cases.resolve(
      world.clinicId,
      await onlyCaseId(world),
      USER,
      {
        kind: 'handled_outside',
        note: 'Result brought on paper',
      },
    );
    expect(resolved.resolution).toMatchObject({ kind: 'handled_outside', resolvedBy: 'nurse-ana' });
    expect(world.outbox().at(-1)).toMatchObject({
      type: 'case.resolved',
      payload: { resolution: 'handled_outside' },
    });
  });

  it('feedback: "not useful" needs a reason; it is stored and audited without free text', async () => {
    const world = await pendingLabCase().run();
    const caseId = await onlyCaseId(world);
    await expect(
      world.engine.cases.recordFeedback(world.clinicId, caseId, { useful: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    const feedback = await world.engine.cases.recordFeedback(world.clinicId, caseId, {
      useful: false,
      reason: 'already_handled',
      comment: 'The patient brought the result last week',
      authorId: 'dr-rivas',
    });
    expect(feedback).toMatchObject({ useful: false, reason: 'already_handled' });
    expect(await world.harness.stores.feedback.listForCase(world.clinicId, caseId)).toHaveLength(1);
    const audit = await world.audit(caseId);
    expect(audit.at(-1)).toMatchObject({
      type: 'feedback_recorded',
      actor: { type: 'user', id: 'dr-rivas' },
      payload: { useful: false, reason: 'already_handled' },
    });
    expect(JSON.stringify(audit.at(-1)?.payload)).not.toContain('paper');
    const useful = await world.engine.cases.recordFeedback(world.clinicId, caseId, {
      useful: true,
    });
    expect(useful.useful).toBe(true);
  });
});

describe('condition review', () => {
  it('rejecting an inferred condition cancels its protocol expectations and resolves the case', async () => {
    const world = await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', medications: [{ id: 'mr-1', text: 'metformina 500 mg' }] })
      .at(181)
      .runWatcher()
      .expectCases([{ reasons: ['protocol_diabetes_hba1c', 'protocol_diabetes_visit'] }])
      .run();
    const result = await world.engine.conditions.reject(
      world.clinicId,
      world.patientId,
      icd10('E14'),
      'dr-rivas',
    );
    expect(result.condition).toMatchObject({
      status: 'resolved',
      confidence: 0,
      confirmedBy: 'dr-rivas',
    });
    expect(result.expectationsCancelled).toBe(4);
    expect(result.casesResolved).toHaveLength(1);
    expect(await world.activeCases()).toHaveLength(0);

    await world.engine.ingest(
      consultation(world.context(), {
        encounterId: 'enc-2',
        medications: [{ id: 'mr-2', text: 'metformina 500 mg' }],
      }),
    );
    const conditions = await world.harness.stores.conditions.listByPatient(
      world.clinicId,
      world.patientId,
    );
    expect(conditions).toMatchObject([{ status: 'resolved' }]);
  });

  it('confirming a probable condition makes the case eligible for patient contact', async () => {
    const world = await scenario({ allowPatientContact: true })
      .at(0)
      .consult({ encounterId: 'enc-1', medications: [{ id: 'mr-1', text: 'Losartán 50 mg' }] })
      .act('confirm hypertension', async (current) => {
        const confirmed = await current.engine.conditions.confirm(
          current.clinicId,
          current.patientId,
          icd10('I10'),
          'dr-rivas',
        );
        expect(confirmed).toMatchObject({
          status: 'confirmed',
          confidence: 1,
          confirmedBy: 'dr-rivas',
        });
      })
      .at(181)
      .runWatcher()
      .runEscalation()
      .at(195)
      .runEscalation()
      .run();
    expect(contactRequests(world)).toHaveLength(1);
    await expect(
      world.engine.conditions.confirm(world.clinicId, world.patientId, icd10('J45'), 'dr-rivas'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      world.engine.conditions.confirm(world.clinicId, world.patientId, icd10('I10'), ''),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
