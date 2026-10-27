import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  type CaseEvent,
  clinicId,
  type ClinicId,
  type CommunicationRecordResult,
  type CommunicationStatus,
  type ContactOutcome,
  type ContactRequest,
  contactRequestId,
  type FollowUpCase,
  NotFoundError,
  patientId,
  type PatientContactRequestedPayload,
  ValidationError,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentResource,
  encounterResource,
  labOrderResource,
  noteResource,
  optOutBundle,
  transactionOf,
} from '../src/bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { snapshotPatient } from '../src/scenario-runner.ts';

/**
 * HIP-136: the patient-contact loop on `default_v2`. A doctor's-plan visit
 * ("control en 19 dias" on day 1) is due on day 20, when its case opens.
 * The policy then asks the host for a WhatsApp on day 34 (answer window 7),
 * the team for a call on day 41 (window 3, unless the patient answered), the
 * coordinator on day 41, a second WhatsApp on day 48, and declares the case
 * lost on day 55 only if every attempt is over and nobody answered. The host
 * reports what came of each attempt as a FHIR `Communication`
 * (`engine.contacts.recordCommunication`); the team records its calls in the
 * inbox (`engine.cases.recordCallOutcome`).
 */

const OPENED = 20;
const FIRST_WHATSAPP = OPENED + 14;
const CALL = OPENED + 21;
const SECOND_WHATSAPP = OPENED + 28;
const LOST = OPENED + 35;
const USER = { type: 'user', id: 'recepcion-ana' } as const;

/** The value, which the test just asserted is there. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
  await harness.engine.runEscalation(harness.clinicId, now);
}

async function days(harness: EngineHarness, from: number, to: number) {
  for (let n = from; n <= to; n += 1) {
    await day(harness, n);
  }
}

/** An internal medicine consultation whose plan asks for a control in 19 days. */
function consultation(patient: string, at: number, suffix = '1'): unknown {
  const encounterId = `enc-${patient}-${suffix}`;
  return transactionOf(
    encounterResource({
      id: encounterId,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(at),
    }),
    noteResource({
      id: `note-${patient}-${suffix}`,
      patientId: patient,
      encounterId,
      specialty: 'internal_medicine',
      text: 'Paciente estable. Plan: control en 19 dias.',
      at: dayToDate(at),
    }),
  );
}

/** The visit of the control, `at`. */
function visit(patient: string, at: number, suffix = 'visit'): unknown {
  return transactionOf(
    encounterResource({
      id: `enc-${patient}-${suffix}`,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(at),
    }),
  );
}

function booking(
  patient: string,
  bookedAt: number,
  start: number,
  status: 'booked' | 'noshow' = 'booked',
): unknown {
  return transactionOf(
    appointmentResource({
      id: `appt-${patient}`,
      patientId: patient,
      specialty: 'internal_medicine',
      start: dayToDate(start),
      bookedAt: dayToDate(bookedAt),
      status,
      version: status === 'booked' ? 1 : 2,
      at: dayToDate(status === 'booked' ? bookedAt : start),
    }),
  );
}

async function casesOf(harness: EngineHarness, patient: string): Promise<FollowUpCase[]> {
  return [...(await snapshotPatient(harness, patientId(patient))).cases];
}

async function onlyCase(harness: EngineHarness, patient: string): Promise<FollowUpCase> {
  const cases = await casesOf(harness, patient);
  expect(cases).toHaveLength(1);
  return defined(cases[0]);
}

async function attempts(harness: EngineHarness, patient: string): Promise<ContactRequest[]> {
  return [
    ...(await harness.read((stores) =>
      stores.contacts.listRequestsForPatient(harness.clinicId, patientId(patient)),
    )),
  ];
}

async function audit(harness: EngineHarness, caseId: string): Promise<CaseEvent[]> {
  return [
    ...(await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, caseId as FollowUpCase['id']),
    )),
  ];
}

async function contactWebhooks(harness: EngineHarness): Promise<PatientContactRequestedPayload[]> {
  return (await harness.pendingEvents()).flatMap((event) =>
    event.type === 'patient_contact.requested' ? [event.payload] : [],
  );
}

async function resolutions(harness: EngineHarness): Promise<string[]> {
  return (await harness.pendingEvents()).flatMap((event) =>
    event.type === 'case.resolved' ? [event.payload.resolution] : [],
  );
}

const UNREACHED: readonly ContactOutcome[] = ['no_answer', 'wrong_number'];

/** The host reports what came of an attempt (a FHIR `Communication`). */
function report(
  harness: EngineHarness,
  request: ContactRequest,
  outcome: ContactOutcome,
  options: {
    readonly id?: string;
    readonly version?: string;
    readonly status?: CommunicationStatus;
    readonly patient?: string;
    readonly clinic?: ClinicId;
  } = {},
): Promise<CommunicationRecordResult> {
  return harness.engine.contacts.recordCommunication(options.clinic ?? harness.clinicId, {
    id: options.id ?? `comm-${request.id}-${outcome}`,
    requestId: request.id,
    ...(options.patient === undefined ? {} : { patientId: patientId(options.patient) }),
    channel: request.channel ?? 'whatsapp',
    status: options.status ?? (UNREACHED.includes(outcome) ? 'not-done' : 'completed'),
    outcome,
    sentAt: request.requestedAt,
    sender: { type: 'host' },
    ...(options.version === undefined ? {} : { versionId: options.version }),
  });
}

function contactLoop(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (
    name: string,
    settings: HarnessOptions['settings'] = { escalationPolicyId: 'default_v2' },
  ): HarnessOptions => ({
    clinicId: clinicId(`clinic-contact-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
    settings: { allowPatientContact: true, ...settings },
  });

  /** Day 1 consultation, then every day up to the first WhatsApp. */
  async function untilFirstWhatsApp(harness: EngineHarness, patient: string) {
    await day(harness, 1, [consultation(patient, 1)]);
    await days(harness, 2, FIRST_WHATSAPP);
    const opened = await onlyCase(harness, patient);
    expect(opened).toMatchObject({ escalationPolicyId: 'default_v2', status: 'notified' });
    expect(opened.createdAt).toEqual(dayToDate(OPENED));
    const [first, ...rest] = await attempts(harness, patient);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      caseId: opened.id,
      channel: 'whatsapp',
      trigger: 'policy',
      attempt: 1,
      requestedAt: dayToDate(FIRST_WHATSAPP),
      dueBy: dayToDate(FIRST_WHATSAPP + 7),
    });
    return { followUpCase: opened, request: defined(first) };
  }

  it('replied, booked and attended: the visit fulfills the case', async () => {
    const harness = await makeHarness(options('attended'));
    const { request } = await untilFirstWhatsApp(harness, 'p-attended');
    expect(await contactWebhooks(harness)).toEqual([
      expect.objectContaining({
        requestId: request.id,
        channel: 'whatsapp',
        attempt: 1,
        purpose: 'schedule_follow_up',
        dueBy: dayToDate(FIRST_WHATSAPP + 7),
      }),
    ]);
    harness.clock.set(dayToDate(FIRST_WHATSAPP + 1));
    await report(harness, request, 'delivered', { id: 'wa-1', version: '1' });
    await report(harness, request, 'replied', { id: 'wa-1', version: '2' });
    const booked = await report(harness, request, 'booked', { id: 'wa-1', version: '3' });
    expect(booked).toMatchObject({ changed: true, outcome: 'booked', reactions: ['none'] });
    await day(harness, FIRST_WHATSAPP + 1, [
      booking('p-attended', FIRST_WHATSAPP + 1, FIRST_WHATSAPP + 5),
    ]);
    expect(await onlyCase(harness, 'p-attended')).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'fulfilled' },
    });
    await days(harness, FIRST_WHATSAPP + 2, FIRST_WHATSAPP + 4);
    await day(harness, FIRST_WHATSAPP + 5, [visit('p-attended', FIRST_WHATSAPP + 5)]);
    await days(harness, FIRST_WHATSAPP + 6, LOST + 5);
    const snapshot = await snapshotPatient(harness, patientId('p-attended'));
    expect(snapshot.cases).toHaveLength(1);
    expect(snapshot.expectations.filter((e) => e.layer === 'doctor_plan')).toMatchObject([
      { status: 'fulfilled', closedBy: { resourceType: 'Encounter' } },
    ]);
    // One message, no call: the case closed before.
    expect(await attempts(harness, 'p-attended')).toHaveLength(1);
    expect(await resolutions(harness)).toEqual(['fulfilled']);
  });

  it('replied and booked, then a no-show: a new case, and the patient is contacted again', async () => {
    const harness = await makeHarness(options('no-show'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-no-show');
    await report(harness, request, 'booked');
    const appointmentDay = FIRST_WHATSAPP + 5;
    await day(harness, FIRST_WHATSAPP + 1, [
      booking('p-no-show', FIRST_WHATSAPP + 1, appointmentDay),
    ]);
    expect((await onlyCase(harness, 'p-no-show')).status).toBe('resolved');
    await days(harness, FIRST_WHATSAPP + 2, appointmentDay - 1);
    await day(harness, appointmentDay, [
      booking('p-no-show', FIRST_WHATSAPP + 1, appointmentDay, 'noshow'),
    ]);
    await day(harness, appointmentDay + 1);
    const reopened = (await casesOf(harness, 'p-no-show')).find(
      (candidate) => candidate.id !== followUpCase.id,
    );
    expect(reopened).toMatchObject({ status: 'notified', escalationPolicyId: 'default_v2' });
    await days(harness, appointmentDay + 2, appointmentDay + 1 + 14);
    const again = (await attempts(harness, 'p-no-show')).filter(
      (candidate) => candidate.caseId === reopened?.id,
    );
    expect(again).toMatchObject([{ channel: 'whatsapp', attempt: 1, trigger: 'policy' }]);
    expect((await contactWebhooks(harness)).map((payload) => payload.caseId)).toEqual([
      followUpCase.id,
      reopened?.id,
    ]);
  });

  it('no answer on WhatsApp: the team calls on day 21, reaches the patient, who books', async () => {
    const harness = await makeHarness(options('call'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-call');
    harness.clock.set(dayToDate(FIRST_WHATSAPP + 1));
    await report(harness, request, 'delivered');
    await days(harness, FIRST_WHATSAPP + 1, CALL - 1);
    expect(await attempts(harness, 'p-call')).toHaveLength(1);
    await day(harness, CALL);
    const [, call] = await attempts(harness, 'p-call');
    expect(call).toMatchObject({
      channel: 'phone_call',
      trigger: 'policy',
      attempt: 2,
      dueBy: dayToDate(CALL + 3),
    });
    expect(await onlyCase(harness, 'p-call')).toMatchObject({
      status: 'escalated',
      assignee: 'coordinator',
    });
    // A call is the team's task: nothing is asked of the host.
    expect(await contactWebhooks(harness)).toHaveLength(1);
    harness.clock.set(dayToDate(CALL + 1));
    const recorded = await harness.engine.cases.recordCallOutcome(
      harness.clinicId,
      followUpCase.id,
      { outcome: 'booked' },
      USER,
    );
    expect(recorded).toMatchObject({ outcome: 'booked', changed: true });
    expect(recorded.communication).toMatchObject({
      requestId: call?.id,
      channel: 'phone_call',
      status: 'completed',
      sender: { type: 'user', id: USER.id },
    });
    // The host hears what the team learned on the phone (ids and codes only).
    expect(
      (await harness.pendingEvents()).filter((event) => event.type === 'contact.outcome_recorded'),
    ).toMatchObject([
      {
        payload: {
          caseId: followUpCase.id,
          requestId: call?.id,
          channel: 'phone_call',
          outcome: 'booked',
        },
      },
    ]);
    await day(harness, CALL + 1, [booking('p-call', CALL + 1, CALL + 6)]);
    expect(await onlyCase(harness, 'p-call')).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'fulfilled' },
    });
    const outcomes = (await audit(harness, followUpCase.id)).filter(
      (event) => event.type === 'contact_outcome_recorded',
    );
    expect(outcomes.map((event) => [event.payload['outcome'], event.actor.type])).toEqual([
      ['delivered', 'patient'],
      ['booked', 'user'],
    ]);
  });

  it('wrong number: the call comes forward, the contact data is flagged and messages stop', async () => {
    const harness = await makeHarness(options('wrong-number'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-wrong');
    harness.clock.set(dayToDate(FIRST_WHATSAPP + 1));
    const wrong = await report(harness, request, 'wrong_number');
    expect(wrong.reactions).toEqual(['contact_data_flagged', 'call_requested']);
    const [, call] = await attempts(harness, 'p-wrong');
    expect(call).toMatchObject({
      channel: 'phone_call',
      trigger: 'wrong_number',
      requestedAt: dayToDate(FIRST_WHATSAPP + 1),
    });
    expect(
      await harness.engine.patientContactStatus(harness.clinicId, patientId('p-wrong')),
    ).toMatchObject({ allowed: true, contactDataInvalid: true });
    expect(
      (await harness.engine.contacts.forPatient(harness.clinicId, patientId('p-wrong'))).flags,
    ).toMatchObject([{ issue: 'wrong_number', communicationId: wrong.communication.id }]);
    harness.clock.set(dayToDate(FIRST_WHATSAPP + 2));
    await harness.engine.cases.recordCallOutcome(
      harness.clinicId,
      followUpCase.id,
      { outcome: 'no_answer' },
      USER,
    );
    await days(harness, FIRST_WHATSAPP + 1, SECOND_WHATSAPP - 1);
    const skips = () =>
      audit(harness, followUpCase.id).then((events) =>
        events
          .filter((event) => event.type === 'contact_attempt_skipped')
          .map((event) => [event.payload['channel'], event.payload['reason']]),
      );
    // The policy's own call: already requested.
    expect(await skips()).toEqual([['phone_call', 'already_requested']]);
    expect(await attempts(harness, 'p-wrong')).toHaveLength(2);
    // The second WhatsApp cannot reach the patient: skipped, and the case is
    // lost at once (both attempts over, nobody answered).
    await day(harness, SECOND_WHATSAPP);
    expect(await skips()).toEqual([
      ['phone_call', 'already_requested'],
      ['whatsapp', 'contact_data_invalid'],
    ]);
    expect(await onlyCase(harness, 'p-wrong')).toMatchObject({
      status: 'lost_to_follow_up',
      resolution: { kind: 'patient_unreachable' },
    });
    expect(await contactWebhooks(harness)).toHaveLength(1);
  });

  it('wrong number, then the team reaches the patient: the flag clears', async () => {
    const harness = await makeHarness(options('wrong-cleared'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-cleared');
    await report(harness, request, 'wrong_number');
    const called = await harness.engine.cases.recordCallOutcome(
      harness.clinicId,
      followUpCase.id,
      { outcome: 'booked' },
      USER,
    );
    expect(called.outcome).toBe('booked');
    expect(
      await harness.engine.patientContactStatus(harness.clinicId, patientId('p-cleared')),
    ).toMatchObject({ contactDataInvalid: false });
    const [flag] = (
      await harness.engine.contacts.forPatient(harness.clinicId, patientId('p-cleared'))
    ).flags;
    expect(flag?.clearedAt).toBeInstanceOf(Date);
    // Answered: the later attempts that skip when answered do not happen.
    await days(harness, FIRST_WHATSAPP + 1, LOST + 3);
    expect(await attempts(harness, 'p-cleared')).toHaveLength(2);
    expect((await onlyCase(harness, 'p-cleared')).status).toBe('escalated');
  });

  it('treated elsewhere resolves the case as handled outside', async () => {
    const harness = await makeHarness(options('elsewhere'));
    const { request } = await untilFirstWhatsApp(harness, 'p-elsewhere');
    const result = await report(harness, request, 'treated_elsewhere');
    expect(result.reactions).toEqual(['case_resolved_handled_outside']);
    expect(await onlyCase(harness, 'p-elsewhere')).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'handled_outside' },
    });
    expect(await resolutions(harness)).toEqual(['handled_outside']);
  });

  it('declined resolves the case as patient declined', async () => {
    const harness = await makeHarness(options('declined'));
    const { request } = await untilFirstWhatsApp(harness, 'p-declined');
    const result = await report(harness, request, 'declined');
    expect(result.reactions).toEqual(['case_resolved_patient_declined']);
    expect(await onlyCase(harness, 'p-declined')).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'patient_declined' },
    });
    expect(await resolutions(harness)).toEqual(['patient_declined']);
  });

  it('every attempt exhausted: lost only once the last answer window is over', async () => {
    const harness = await makeHarness(options('exhausted'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-exhausted');
    harness.clock.set(dayToDate(FIRST_WHATSAPP + 1));
    await report(harness, request, 'delivered');
    await days(harness, FIRST_WHATSAPP + 1, CALL);
    harness.clock.set(dayToDate(CALL + 1));
    await harness.engine.cases.recordCallOutcome(
      harness.clinicId,
      followUpCase.id,
      { outcome: 'no_answer' },
      USER,
    );
    await days(harness, CALL + 1, LOST - 1);
    expect(
      (await attempts(harness, 'p-exhausted')).map((attempt) => [attempt.channel, attempt.attempt]),
    ).toEqual([
      ['whatsapp', 1],
      ['phone_call', 2],
      ['whatsapp', 3],
    ]);
    // The second WhatsApp's window ends on day 55: not lost the day before.
    expect((await onlyCase(harness, 'p-exhausted')).status).toBe('escalated');
    expect(await resolutions(harness)).toEqual([]);
    await day(harness, LOST);
    expect(await onlyCase(harness, 'p-exhausted')).toMatchObject({
      status: 'lost_to_follow_up',
      resolution: { kind: 'patient_unreachable' },
    });
    expect((await contactWebhooks(harness)).map((payload) => payload.attempt)).toEqual([1, 3]);
  });

  it('an opt-out mid-sequence stops every later attempt; the case closes as declined', async () => {
    const harness = await makeHarness(options('opt-out'));
    const { followUpCase } = await untilFirstWhatsApp(harness, 'p-opt-out');
    await day(harness, FIRST_WHATSAPP + 2, [
      optOutBundle({
        id: 'consent-p-opt-out',
        patientId: 'p-opt-out',
        at: dayToDate(FIRST_WHATSAPP + 2),
      }),
    ]);
    await days(harness, FIRST_WHATSAPP + 3, SECOND_WHATSAPP - 1);
    expect((await onlyCase(harness, 'p-opt-out')).status).toBe('escalated');
    await day(harness, SECOND_WHATSAPP);
    expect(await attempts(harness, 'p-opt-out')).toHaveLength(1);
    const skipped = (await audit(harness, followUpCase.id))
      .filter((event) => event.type === 'contact_attempt_skipped')
      .map((event) => [event.payload['channel'], event.payload['reason']]);
    expect(skipped).toEqual([
      ['phone_call', 'patient_opted_out'],
      ['whatsapp', 'patient_opted_out'],
    ]);
    expect(await onlyCase(harness, 'p-opt-out')).toMatchObject({
      status: 'lost_to_follow_up',
      resolution: { kind: 'patient_declined' },
    });
  });

  it('outcomes are idempotent, version-aware, clinic-isolated and checked against the attempt', async () => {
    const harness = await makeHarness(options('idempotent'));
    const { request, followUpCase } = await untilFirstWhatsApp(harness, 'p-idem');
    const first = await report(harness, request, 'replied', { id: 'wa-idem', version: '2' });
    expect(first).toMatchObject({ changed: true, stale: false, outcome: 'replied' });
    const again = await report(harness, request, 'replied', { id: 'wa-idem', version: '2' });
    expect(again).toMatchObject({ changed: false, stale: false, reactions: [] });
    const older = await report(harness, request, 'delivered', { id: 'wa-idem', version: '1' });
    expect(older).toMatchObject({ changed: false, stale: true, reactions: [] });
    expect(older.communication.outcome).toBe('replied');
    const recorded = (await audit(harness, followUpCase.id)).filter(
      (event) => event.type === 'contact_outcome_recorded',
    );
    expect(recorded).toHaveLength(1);

    const unknown = { ...request, id: contactRequestId('cr-unknown') };
    await expect(report(harness, unknown, 'replied')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      report(harness, request, 'replied', { clinic: clinicId('clinic-someone-else') }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      report(harness, request, 'replied', { id: 'wa-other', patient: 'p-someone-else' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('one automatic message per patient per 14 days across cases; calls are exempt', async () => {
    const harness = await makeHarness(options('window'));
    // A lab order on day 0 (its case opens on day 15) and the plan's control
    // on day 1 (its case opens on day 20): two cases, two reason groups.
    await day(harness, 0, [
      transactionOf(
        labOrderResource({
          id: 'sr-window',
          patientId: 'p-window',
          loinc: '2160-0',
          at: dayToDate(0),
        }),
      ),
    ]);
    await day(harness, 1, [consultation('p-window', 1)]);
    await days(harness, 2, CALL + 1);
    const cases = await casesOf(harness, 'p-window');
    expect(cases).toHaveLength(2);
    const lab = cases.find(
      (candidate) => candidate.createdAt.getTime() < dayToDate(OPENED).getTime(),
    );
    const plan = defined(cases.find((candidate) => candidate.id !== lab?.id));
    const all = await attempts(harness, 'p-window');
    const messages = all.filter((attempt) => attempt.channel !== 'phone_call');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.caseId).toBe(lab?.id);
    const calls = all.filter((attempt) => attempt.channel === 'phone_call');
    expect(new Set(calls.map((call) => call.caseId))).toEqual(new Set([lab?.id, plan.id]));
    const skipped = (await audit(harness, plan.id))
      .filter((event) => event.type === 'contact_attempt_skipped')
      .map((event) => event.payload['reason']);
    expect(skipped).toEqual(['contact_window']);
    expect(await contactWebhooks(harness)).toHaveLength(1);
  });

  it('a clinic on default_v1 keeps its single request, now a CommunicationRequest with no channel', async () => {
    const harness = await makeHarness(options('v1', {}));
    await day(harness, 1, [consultation('p-v1', 1)]);
    await days(harness, 2, FIRST_WHATSAPP);
    const followUpCase = await onlyCase(harness, 'p-v1');
    expect(followUpCase.escalationPolicyId).toBe('default_v1');
    const [request, ...rest] = await attempts(harness, 'p-v1');
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ trigger: 'policy', attempt: 1, policyStep: 2 });
    expect(request?.channel).toBeUndefined();
    const [webhook] = await contactWebhooks(harness);
    expect(webhook).toMatchObject({ requestId: request?.id, attempt: 1 });
    expect(webhook).not.toHaveProperty('channel');
    // A reply on v1 is recorded like on v2: the patient answered, not lost.
    await report(harness, defined(request), 'replied');
    await days(harness, FIRST_WHATSAPP + 1, LOST + 5);
    expect((await onlyCase(harness, 'p-v1')).status).toBe('escalated');
  });
}

// Each case simulates weeks of sweeps day by day.
const TIMEOUT_MS = 60_000;

describe('patient-contact loop (memory)', { timeout: TIMEOUT_MS }, () => {
  contactLoop((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('patient-contact loop'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    contactLoop((options) => postgresHarness(database(), options));
  },
);
