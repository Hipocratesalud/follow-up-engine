import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentResource,
  diagnosticReportResource,
  encounterResource,
  labOrderResource,
  noteResource,
  observationResource,
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
 * HIP-133: appointment and visit lifecycle v2. The booking tolerance scales
 * with the interval; a rescheduled or re-booked Appointment counts by its
 * latest version; a booking whose date passed without a visit stops
 * fulfilling; an encounter entered in error withdraws what it fulfilled and
 * anchors nothing; a referral is fulfilled by the specialty it names; a
 * report entered in error withdraws its results.
 */

const HOUR = 3_600_000;

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

function consultation(input: {
  readonly patient: string;
  readonly id: string;
  readonly at: number;
  readonly specialty: string;
  readonly note?: string;
}): unknown {
  const at = dayToDate(input.at);
  return transactionOf(
    encounterResource({ id: input.id, patientId: input.patient, specialty: input.specialty, at }),
    ...(input.note === undefined
      ? []
      : [
          noteResource({
            id: `${input.id}-note`,
            patientId: input.patient,
            encounterId: input.id,
            specialty: input.specialty,
            text: input.note,
            at,
          }),
        ]),
  );
}

function rule(snapshot: { readonly expectations: readonly Expectation[] }, ruleId: string) {
  return snapshot.expectations.filter((expectation) => expectation.ruleId === ruleId);
}

async function plan(harness: EngineHarness, patient: string) {
  return rule(await snapshotPatient(harness, patientId(patient)), 'doctor_plan_followup');
}

async function activeRuleIds(harness: EngineHarness, patient: string) {
  const snapshot = await snapshotPatient(harness, patientId(patient));
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .map((followUpCase) => [...followUpCase.ruleIds].sort());
}

function booking(input: {
  readonly id: string;
  readonly patient: string;
  readonly start: number;
  readonly bookedAt: number;
  readonly version?: number;
  readonly at?: number;
  readonly status?: 'booked' | 'cancelled';
  readonly specialty?: string;
}): unknown {
  return transactionOf(
    appointmentResource({
      id: input.id,
      patientId: input.patient,
      specialty: input.specialty ?? 'internal_medicine',
      start: dayToDate(input.start),
      bookedAt: dayToDate(input.bookedAt),
      status: input.status ?? 'booked',
      version: input.version ?? 1,
      at: dayToDate(input.at ?? input.bookedAt),
    }),
  );
}

function lifecycle(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-lifecycle-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('a booking a week or two after a 3-month control date fulfills it; a month after does not', async () => {
    const harness = await makeHarness(options('tolerance'));
    for (const [patient, offset] of [
      ['p-tol-8', 8],
      ['p-tol-13', 13],
      ['p-tol-30', 30],
    ] as const) {
      await day(harness, 0, [
        consultation({
          patient,
          id: `${patient}-e1`,
          at: 0,
          specialty: 'diabetology',
          note: 'Paciente estable. Plan: control en 3 meses.',
        }),
        booking({
          id: `${patient}-ap`,
          patient,
          start: 90 + offset,
          bookedAt: 0,
          specialty: 'diabetology',
        }),
      ]);
    }
    expect((await plan(harness, 'p-tol-8')).map((e) => e.status)).toEqual(['fulfilled']);
    expect((await plan(harness, 'p-tol-13')).map((e) => e.status)).toEqual(['fulfilled']);
    expect((await plan(harness, 'p-tol-30')).map((e) => e.status)).toEqual(['open']);
  });

  it('a short follow-up keeps a strict tolerance', async () => {
    const harness = await makeHarness(options('tolerance-short'));
    const patient = 'p-tol-short';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'ts-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Plan: control en 14 dias.',
      }),
      booking({ id: 'ts-ap', patient, start: 19, bookedAt: 0 }),
    ]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['open']);
  });

  it('a booking rescheduled past the due date no longer fulfills the plan', async () => {
    const harness = await makeHarness(options('rescheduled'));
    const patient = 'p-b6';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'b6-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Paciente estable. Plan: control en 14 dias.',
      }),
    ]);
    await day(harness, 1, [booking({ id: 'b6-ap1', patient, start: 10, bookedAt: 1 })]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['fulfilled']);
    await days(harness, 2, 7);
    await day(harness, 8, [
      booking({ id: 'b6-ap1', patient, start: 60, bookedAt: 1, version: 2, at: 8 }),
    ]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['open']);
    await days(harness, 9, 16);
    expect(await activeRuleIds(harness, patient)).toEqual([['doctor_plan_followup']]);
  });

  it('the same Appointment booked again after its cancellation fulfills the plan', async () => {
    const harness = await makeHarness(options('rebooked'));
    const patient = 'p-b7';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'b7-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Paciente estable. Plan: control en 14 dias.',
      }),
    ]);
    await day(harness, 1, [booking({ id: 'b7-ap1', patient, start: 10, bookedAt: 1 })]);
    await days(harness, 2, 4);
    await day(harness, 5, [
      booking({
        id: 'b7-ap1',
        patient,
        start: 10,
        bookedAt: 1,
        version: 2,
        at: 5,
        status: 'cancelled',
      }),
    ]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['open']);
    await day(harness, 6, [
      booking({ id: 'b7-ap1', patient, start: 12, bookedAt: 1, version: 3, at: 6 }),
    ]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['fulfilled']);
    await day(harness, 12, [
      consultation({ patient, id: 'b7-e2', at: 12, specialty: 'internal_medicine' }),
    ]);
    await days(harness, 13, 40);
    expect(await activeRuleIds(harness, patient)).toEqual([]);
  });

  it('a booked date that passes without a visit reopens the plan after the grace days', async () => {
    const harness = await makeHarness(options('lapsed'));
    const patient = 'p-b8';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'b8-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Paciente estable. Plan: control en 14 dias.',
      }),
    ]);
    await day(harness, 1, [booking({ id: 'b8-ap1', patient, start: 10, bookedAt: 1 })]);
    await days(harness, 2, 11);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['fulfilled']);
    await days(harness, 12, 13);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['open']);
    await days(harness, 14, 15);
    expect(await activeRuleIds(harness, patient)).toEqual([['doctor_plan_followup']]);
  });

  it('a booking kept by the visit stays fulfilled, now by the visit', async () => {
    const harness = await makeHarness(options('kept'));
    const patient = 'p-kept';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'kp-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Paciente estable. Plan: control en 14 dias.',
      }),
    ]);
    await day(harness, 1, [booking({ id: 'kp-ap1', patient, start: 10, bookedAt: 1 })]);
    await days(harness, 2, 9);
    await day(harness, 10, [
      consultation({ patient, id: 'kp-e2', at: 10, specialty: 'internal_medicine' }),
    ]);
    await days(harness, 11, 30);
    expect(await plan(harness, patient)).toMatchObject([
      { status: 'fulfilled', closedBy: { resourceType: 'Encounter', id: 'kp-e2' } },
    ]);
    expect(await activeRuleIds(harness, patient)).toEqual([]);
  });

  it('an encounter entered in error reopens the plan it fulfilled and anchors nothing', async () => {
    const harness = await makeHarness(options('encounter-error'));
    const patient = 'p-b14';
    await day(harness, -60, [
      consultation({ patient, id: 'b14-e0', at: -60, specialty: 'internal_medicine' }),
    ]);
    await day(harness, -30, [
      consultation({ patient, id: 'b14-em', at: -30, specialty: 'internal_medicine' }),
    ]);
    await day(harness, 0, [
      consultation({
        patient,
        id: 'b14-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Paciente estable. Plan: control en 14 dias.',
      }),
    ]);
    await day(harness, 8, [
      consultation({
        patient,
        id: 'b14-e2',
        at: 8,
        specialty: 'internal_medicine',
        note: 'Control. Estable.',
      }),
    ]);
    expect((await plan(harness, patient)).map((e) => e.status)).toEqual(['fulfilled']);
    await day(harness, 9, [
      transactionOf(
        encounterResource({
          id: 'b14-e2',
          patientId: patient,
          specialty: 'internal_medicine',
          status: 'entered-in-error',
          version: 2,
          at: dayToDate(9),
        }),
      ),
    ]);
    const after = await snapshotPatient(harness, patientId(patient));
    expect(rule(after, 'doctor_plan_followup').map((e) => e.status)).toEqual(['open']);
    expect(
      rule(after, 'cadence_break').filter(
        (e) => e.source.id === 'b14-e2' && (e.status === 'open' || e.status === 'expired'),
      ),
    ).toEqual([]);
    await days(harness, 10, 40);
    expect(await activeRuleIds(harness, patient)).toEqual([['doctor_plan_followup']]);
  });

  it('a referral to another specialty is fulfilled by that specialty, not by the author', async () => {
    const harness = await makeHarness(options('referral'));
    await day(harness, 0, [
      consultation({
        patient: 'p-rf1',
        id: 'rf1-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Soplo cardiaco. Plan: control con cardiologia en 1 mes.',
      }),
      consultation({
        patient: 'p-rf2',
        id: 'rf2-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Soplo cardiaco. Plan: control con cardiología en 1 mes.',
      }),
    ]);
    await days(harness, 1, 24);
    await day(harness, 25, [
      consultation({
        patient: 'p-rf1',
        id: 'rf1-e2',
        at: 25,
        specialty: 'cardiology',
        note: 'Ecocardiograma normal. Soplo funcional.',
      }),
      consultation({ patient: 'p-rf2', id: 'rf2-e2', at: 25, specialty: 'internal_medicine' }),
    ]);
    await days(harness, 26, 40);
    expect((await plan(harness, 'p-rf1')).map((e) => e.status)).toEqual(['fulfilled']);
    expect(await activeRuleIds(harness, 'p-rf1')).toEqual([]);
    expect((await plan(harness, 'p-rf2')).map((e) => e.status)).toEqual(['expired']);
  });

  it('a report entered in error withdraws its results: the order is pending again', async () => {
    const harness = await makeHarness(options('report-error'));
    const patient = 'p-w1';
    await day(harness, 0, [
      transactionOf(
        labOrderResource({ id: 'w1-sr1', patientId: patient, loinc: '2160-0', at: dayToDate(0) }),
      ),
    ]);
    const report = {
      id: 'w1-dr1',
      patientId: patient,
      loinc: '2160-0',
      resultIds: ['w1-dr1-obs'],
      basedOn: 'w1-sr1',
    };
    await day(harness, 2, [
      transactionOf(
        diagnosticReportResource({ ...report, at: new Date(dayToDate(2).getTime() + HOUR) }),
        observationResource({
          id: 'w1-dr1-obs',
          patientId: patient,
          loinc: '2160-0',
          value: 1.0,
          unit: 'mg/dL',
          interpretation: 'N',
          at: new Date(dayToDate(2).getTime() + HOUR),
        }),
      ),
    ]);
    expect(
      rule(await snapshotPatient(harness, patientId(patient)), 'lab_order_result_pending').map(
        (e) => e.status,
      ),
    ).toEqual(['fulfilled']);
    await day(harness, 5, [
      transactionOf(
        diagnosticReportResource({
          ...report,
          status: 'entered-in-error',
          version: 2,
          at: dayToDate(5),
        }),
      ),
    ]);
    expect(
      rule(await snapshotPatient(harness, patientId(patient)), 'lab_order_result_pending').map(
        (e) => e.status,
      ),
    ).toEqual(['open']);
    await days(harness, 6, 16);
    expect(await activeRuleIds(harness, patient)).toEqual([['lab_order_result_pending']]);
  });
}

describe('appointment and visit lifecycle (memory)', () => {
  lifecycle((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('appointment and visit lifecycle'), () => {
  const database = useIsolatedDatabase();
  lifecycle((options) => postgresHarness(database(), options));
});
