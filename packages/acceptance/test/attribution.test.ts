import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  type AppointmentBookedEvent,
  type CaseEvent,
  clinicId,
  type FollowUpCase,
  patientId,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentResource,
  encounterResource,
  labOrderResource,
  noteResource,
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
 * HIP-141 attribution, end to end through FHIR: a doctor's-plan visit
 * ("control en 19 dias" on day 1) opens a case on day 20. The host books
 * the visit and says (or does not say) which case or contact attempt the
 * booking answers. The engine verifies the claim, records the booking on
 * the case, resolves it, and records the visit when it keeps the booking
 * (the recheck at the appointment date plus the grace days). The clinic
 * metrics then split bookings and visits by origin.
 */

const OPENED = 20;
const BOOKED = 21;
const VISIT = 25;
const USER = { type: 'user', id: 'recepcion-ana' } as const;

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

function consultation(patient: string): unknown {
  const encounterId = `enc-${patient}-1`;
  return transactionOf(
    encounterResource({
      id: encounterId,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(1),
    }),
    noteResource({
      id: `note-${patient}-1`,
      patientId: patient,
      encounterId,
      specialty: 'internal_medicine',
      text: 'Paciente estable. Plan: control en 19 dias.',
      at: dayToDate(1),
    }),
  );
}

function booking(
  patient: string,
  attribution: Pick<
    Parameters<typeof appointmentResource>[0],
    'originCase' | 'basedOn' | 'supportingInformation'
  > = {},
): unknown {
  return transactionOf(
    appointmentResource({
      id: `appt-${patient}`,
      patientId: patient,
      specialty: 'internal_medicine',
      start: dayToDate(VISIT),
      bookedAt: dayToDate(BOOKED),
      version: 1,
      at: dayToDate(BOOKED),
      ...attribution,
    }),
  );
}

function visit(patient: string): unknown {
  return transactionOf(
    encounterResource({
      id: `enc-${patient}-visit`,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(VISIT),
    }),
  );
}

async function onlyCase(harness: EngineHarness, patient: string): Promise<FollowUpCase> {
  const { cases } = await snapshotPatient(harness, patientId(patient));
  expect(cases).toHaveLength(1);
  const [only] = cases;
  if (only === undefined) throw new Error('expected a case');
  return only;
}

async function trail(harness: EngineHarness, followUpCase: FollowUpCase): Promise<CaseEvent[]> {
  return [
    ...(await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, followUpCase.id),
    )),
  ];
}

async function storedBooking(
  harness: EngineHarness,
  patient: string,
): Promise<AppointmentBookedEvent | undefined> {
  const events = await harness.read((stores) =>
    stores.clinicalRecords.listEventsForPatient(harness.clinicId, patientId(patient), {
      types: ['appointment.booked'],
    }),
  );
  return events.find(
    (event): event is AppointmentBookedEvent => event.type === 'appointment.booked',
  );
}

/** The consultation, then every day until the case opens. */
async function untilCaseOpens(harness: EngineHarness, patient: string): Promise<FollowUpCase> {
  await day(harness, 1, [consultation(patient)]);
  await days(harness, 2, OPENED);
  const opened = await onlyCase(harness, patient);
  expect(opened.createdAt).toEqual(dayToDate(OPENED));
  return opened;
}

/** The booking on day 21, the visit on day 25, every day until the recheck has run. */
async function bookAndVisit(harness: EngineHarness, patient: string, bundle: unknown) {
  await day(harness, BOOKED, [bundle]);
  await days(harness, BOOKED + 1, VISIT - 1);
  await day(harness, VISIT, [visit(patient)]);
  await days(harness, VISIT + 1, VISIT + 3);
}

function attribution(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-attribution-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
    settings: { allowPatientContact: true },
  });

  it('a booking made from the case is attributed to it, resolves it and is attended', async () => {
    const harness = await makeHarness(options('case'));
    const opened = await untilCaseOpens(harness, 'p-team');
    await bookAndVisit(harness, 'p-team', booking('p-team', { originCase: `Task/${opened.id}` }));

    expect(await storedBooking(harness, 'p-team')).toMatchObject({
      origin: { type: 'follow_up_case', caseId: opened.id },
    });
    expect(await onlyCase(harness, 'p-team')).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'fulfilled' },
    });
    const events = await trail(harness, opened);
    const types = events.map((event) => event.type);
    // Booked, then resolved by that booking, then attended.
    expect(types.indexOf('appointment_booked')).toBeLessThan(types.indexOf('resolved'));
    expect(events.find((event) => event.type === 'appointment_booked')?.payload).toEqual({
      appointmentId: 'appt-p-team',
      originType: 'follow_up_case',
      scheduledFor: dayToDate(VISIT).toISOString(),
      fulfilledReasons: 1,
    });
    expect(events.find((event) => event.type === 'resolved')?.payload).toMatchObject({
      kind: 'fulfilled',
      appointmentId: 'appt-p-team',
      appointmentOrigin: 'follow_up_case',
    });
    expect(events.filter((event) => event.type === 'appointment_attended')).toEqual([
      expect.objectContaining({
        actor: { type: 'patient' },
        payload: {
          appointmentId: 'appt-p-team',
          encounterId: 'enc-p-team-visit',
          originType: 'follow_up_case',
        },
      }),
    ]);

    const metrics = await harness.engine.metrics(harness.clinicId);
    expect(metrics.cases).toMatchObject({ opened: 1, resolved: 1 });
    expect(metrics.bookings).toMatchObject({
      booked: { total: 1, followUpCase: 1, patientContact: 0, organic: 0 },
      attended: { total: 1, followUpCase: 1 },
      resolvedByBooking: { total: 1, followUpCase: 1 },
      bookedRate: 1,
      attendedRate: 1,
      attributedShare: 1,
    });
  });

  it('a booking nobody attributes still resolves the case, as an organic one', async () => {
    const harness = await makeHarness(options('organic'));
    const opened = await untilCaseOpens(harness, 'p-organic');
    await bookAndVisit(harness, 'p-organic', booking('p-organic'));

    const stored = await storedBooking(harness, 'p-organic');
    expect(stored).toBeDefined();
    expect(stored?.origin).toBeUndefined();
    expect(await onlyCase(harness, 'p-organic')).toMatchObject({ status: 'resolved' });
    const events = await trail(harness, opened);
    expect(events.find((event) => event.type === 'appointment_booked')?.payload).toMatchObject({
      originType: 'organic',
      fulfilledReasons: 1,
    });
    expect(events.find((event) => event.type === 'resolved')?.payload).toMatchObject({
      appointmentOrigin: 'organic',
    });

    const metrics = await harness.engine.metrics(harness.clinicId);
    expect(metrics.bookings).toMatchObject({
      booked: { total: 1, followUpCase: 0, patientContact: 0, organic: 1 },
      attended: { total: 1, organic: 1 },
      resolvedByBooking: { total: 1, organic: 1 },
      attributedShare: 0,
    });
  });

  it('a booking that answers a contact request is attributed to the contact loop', async () => {
    const harness = await makeHarness(options('contact'));
    const opened = await untilCaseOpens(harness, 'p-contact');
    // The team asks the host to contact the patient (a CommunicationRequest).
    await harness.engine.cases.requestPatientContact(harness.clinicId, opened.id, USER);
    const [request] = await harness.read((stores) =>
      stores.contacts.listRequestsForCase(harness.clinicId, opened.id),
    );
    if (request === undefined) throw new Error('expected a contact request');
    // The host links the booking to the attempt the patient answered.
    await bookAndVisit(
      harness,
      'p-contact',
      booking('p-contact', { basedOn: [`CommunicationRequest/${request.id}`] }),
    );

    expect(await storedBooking(harness, 'p-contact')).toMatchObject({
      origin: { type: 'patient_contact', caseId: opened.id, contactRequestId: request.id },
    });
    const events = await trail(harness, opened);
    expect(events.find((event) => event.type === 'appointment_booked')).toMatchObject({
      actor: { type: 'patient' },
      payload: { originType: 'patient_contact', contactRequestId: request.id },
    });

    const metrics = await harness.engine.metrics(harness.clinicId);
    expect(metrics.bookings).toMatchObject({
      booked: { total: 1, patientContact: 1 },
      attended: { total: 1, patientContact: 1 },
      resolvedByBooking: { total: 1, patientContact: 1 },
    });
    // The contact request was the first action, the day the case opened.
    expect(metrics.timeToFirstAction).toMatchObject({ measured: 1, pending: 0, medianHours: 0 });
  });

  it('a booking that answers the patient card contact request is attributed on every case it covered', async () => {
    const harness = await makeHarness(options('patient-card'));
    const patient = 'p-card';
    // The plan visit (case on day 20) and an HbA1c with no result (an earlier case).
    await day(harness, 1, [
      consultation(patient),
      transactionOf(
        labOrderResource({
          id: `sr-${patient}`,
          patientId: patient,
          loinc: '4548-4',
          authoredOn: dayToDate(1),
          version: 1,
          at: dayToDate(1),
        }),
      ),
    ]);
    await days(harness, 2, OPENED);
    const { cases } = await snapshotPatient(harness, patientId(patient));
    expect(cases).toHaveLength(2);
    // One request for the patient from the inbox card: the other case shares it.
    const { request, primaryCaseId } = await harness.engine.cases.requestPatientContactForPatient(
      harness.clinicId,
      patientId(patient),
      USER,
    );
    await bookAndVisit(
      harness,
      patient,
      booking(patient, { basedOn: [`CommunicationRequest/${request.id}`] }),
    );

    expect(await storedBooking(harness, patient)).toMatchObject({
      origin: { type: 'patient_contact', caseId: primaryCaseId, contactRequestId: request.id },
    });
    for (const followUpCase of cases) {
      const events = await trail(harness, followUpCase);
      expect(
        events.find((event) => event.type === 'appointment_booked')?.payload,
        followUpCase.dedupKey,
      ).toMatchObject({ originType: 'patient_contact', contactRequestId: request.id });
    }
    // The plan visit case is the one the booking fulfills and the visit keeps.
    const planCase = cases.find((item) => item.dedupKey.endsWith(':follow_up'));
    if (planCase === undefined) throw new Error('expected the plan visit case');
    const planEvents = await trail(harness, planCase);
    expect(planEvents.find((event) => event.type === 'resolved')?.payload).toMatchObject({
      appointmentOrigin: 'patient_contact',
    });
    expect(
      planEvents.find((event) => event.type === 'appointment_attended')?.payload,
    ).toMatchObject({ originType: 'patient_contact' });

    const metrics = await harness.engine.metrics(harness.clinicId);
    expect(metrics.bookings).toMatchObject({
      booked: { total: 2, followUpCase: 0, patientContact: 2, organic: 0 },
      attended: { total: 1, patientContact: 1, organic: 0 },
      resolvedByBooking: { total: 1, patientContact: 1, organic: 0 },
    });
  });

  it('a claim the engine cannot verify is stored as organic, unverified', async () => {
    const harness = await makeHarness(options('unverified'));
    const other = await untilCaseOpens(harness, 'p-other');
    await day(harness, 1, [consultation('p-claim')]);
    await days(harness, 2, OPENED);
    // The host names a case of another patient and an attempt that does not exist.
    await bookAndVisit(
      harness,
      'p-claim',
      booking('p-claim', {
        supportingInformation: [`Task/${other.id}`, 'CommunicationRequest/does-not-exist'],
      }),
    );
    expect(await storedBooking(harness, 'p-claim')).toMatchObject({
      origin: { type: 'organic', unverified: true },
    });
    // Nothing lands on the other patient's case.
    expect(
      (await trail(harness, other)).filter((event) => event.type === 'appointment_booked'),
    ).toEqual([]);
    const metrics = await harness.engine.metrics(harness.clinicId);
    expect(metrics.bookings.booked).toEqual({
      total: 1,
      followUpCase: 0,
      patientContact: 0,
      organic: 1,
    });
  });

  it('a re-delivered booking is recorded on the case once', async () => {
    const harness = await makeHarness(options('redelivery'));
    const opened = await untilCaseOpens(harness, 'p-twice');
    const bundle = booking('p-twice', { originCase: `Task/${opened.id}` });
    await day(harness, BOOKED, [bundle, bundle]);
    expect(
      (await trail(harness, opened)).filter((event) => event.type === 'appointment_booked'),
    ).toHaveLength(1);
  });
}

describe('attribution of bookings, HIP-141 (memory)', () => {
  attribution((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('attribution of bookings, HIP-141'), () => {
  const database = useIsolatedDatabase();
  attribution((options) => postgresHarness(database(), options));
});
