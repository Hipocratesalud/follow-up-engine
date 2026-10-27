import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentResource,
  encounterResource,
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
 * HIP-115: what counts as fulfilling an expectation. A booking counts only
 * when it brings the visit in on time; a no-show reopens what its booking
 * fulfilled; a visit of another specialty does not fulfill a follow-up; a
 * cancelled booking leaves nothing anchored on it.
 */

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
  readonly practitionerId?: string;
}): unknown {
  const at = dayToDate(input.at);
  return transactionOf(
    encounterResource({
      id: input.id,
      patientId: input.patient,
      specialty: input.specialty,
      at,
      ...(input.practitionerId === undefined ? {} : { practitionerId: input.practitionerId }),
    }),
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

async function activeRuleIds(harness: EngineHarness, patient: string) {
  const snapshot = await snapshotPatient(harness, patientId(patient));
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .map((followUpCase) => [...followUpCase.ruleIds].sort());
}

function fulfillment(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-fulfillment-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('a booking months after the due date does not fulfill an abnormal result follow-up', async () => {
    const harness = await makeHarness(options('late-booking'));
    const patient = 'p-late-booking';
    await day(harness, 0, [
      consultation({ patient, id: 'lb-e1', at: 0, specialty: 'internal_medicine' }),
      transactionOf(
        observationResource({
          id: 'lb-k1',
          patientId: patient,
          loinc: '2823-3',
          value: 6.4,
          unit: 'mmol/L',
          interpretation: 'HH',
          encounterId: 'lb-e1',
          at: new Date(dayToDate(0).getTime() + 2 * 3_600_000),
        }),
      ),
    ]);
    await day(harness, 1, [
      transactionOf(
        appointmentResource({
          id: 'lb-ap1',
          patientId: patient,
          specialty: 'internal_medicine',
          start: dayToDate(180),
          bookedAt: dayToDate(1),
          at: dayToDate(1),
        }),
      ),
    ]);
    await days(harness, 2, 8);
    const snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'abnormal_result_followup').map((e) => e.status)).toEqual(['expired']);
    expect(await activeRuleIds(harness, patient)).toContainEqual(['abnormal_result_followup']);
  });

  it('a booking on time still fulfills, and an overdue case resolves with a prompt booking', async () => {
    const harness = await makeHarness(options('on-time-booking'));
    const patient = 'p-on-time';
    await day(harness, 0, [
      consultation({ patient, id: 'ot-e1', at: 0, specialty: 'internal_medicine' }),
      transactionOf(
        observationResource({
          id: 'ot-k1',
          patientId: patient,
          loinc: '2823-3',
          value: 6.4,
          unit: 'mmol/L',
          interpretation: 'H',
          encounterId: 'ot-e1',
          at: dayToDate(0),
        }),
      ),
    ]);
    await day(harness, 2, [
      transactionOf(
        appointmentResource({
          id: 'ot-ap1',
          patientId: patient,
          specialty: 'internal_medicine',
          start: dayToDate(6),
          bookedAt: dayToDate(2),
          at: dayToDate(2),
        }),
      ),
    ]);
    let snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'abnormal_result_followup')[0]).toMatchObject({
      status: 'fulfilled',
      closedBy: { resourceType: 'Appointment', id: 'ot-ap1' },
    });
    // The patient keeps the appointment.
    await day(harness, 6, [
      consultation({ patient, id: 'ot-e2', at: 6, specialty: 'internal_medicine' }),
    ]);

    // A second abnormal result, nobody books: the case opens at day 17.
    await day(harness, 10, [
      transactionOf(
        observationResource({
          id: 'ot-k2',
          patientId: patient,
          loinc: '2823-3',
          value: 6.6,
          unit: 'mmol/L',
          interpretation: 'H',
          encounterId: 'ot-e1',
          at: dayToDate(10),
        }),
      ),
    ]);
    await days(harness, 11, 18);
    expect(await activeRuleIds(harness, patient)).toEqual([['abnormal_result_followup']]);
    // The team calls and books for the next days: the case resolves.
    await day(harness, 19, [
      transactionOf(
        appointmentResource({
          id: 'ot-ap2',
          patientId: patient,
          specialty: 'internal_medicine',
          start: dayToDate(22),
          bookedAt: dayToDate(19),
          at: dayToDate(19),
        }),
      ),
    ]);
    snapshot = await snapshotPatient(harness, patientId(patient));
    expect(await activeRuleIds(harness, patient)).toEqual([]);
    expect(snapshot.cases.map((c) => c.resolution?.kind)).toEqual(['fulfilled']);
  });

  it('a no-show reopens what the booking fulfilled and a case opens', async () => {
    const harness = await makeHarness(options('no-show'));
    const patient = 'p-no-show';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'ns-e1',
        at: 0,
        specialty: 'internal_medicine',
        note: 'Control general. Plan: control en 7 dias.',
      }),
      transactionOf(
        appointmentResource({
          id: 'ns-ap1',
          patientId: patient,
          specialty: 'internal_medicine',
          start: dayToDate(7),
          bookedAt: dayToDate(0),
          at: dayToDate(0),
        }),
      ),
    ]);
    let snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup').map((e) => e.status)).toEqual(['fulfilled']);
    await days(harness, 1, 7);
    await day(harness, 8, [
      transactionOf(
        appointmentResource({
          id: 'ns-ap1',
          patientId: patient,
          specialty: 'internal_medicine',
          start: dayToDate(7),
          bookedAt: dayToDate(0),
          status: 'noshow',
          version: 2,
          at: dayToDate(8),
        }),
      ),
    ]);
    await day(harness, 9);
    snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup').map((e) => e.status)).toEqual(['expired']);
    expect(await activeRuleIds(harness, patient)).toEqual([['doctor_plan_followup']]);
  });

  it("a visit of another specialty does not fulfill the diabetologist's planned control", async () => {
    const harness = await makeHarness(options('other-specialty'));
    const patient = 'p-specialty';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'sp-e1',
        at: 0,
        specialty: 'diabetology',
        note: 'DM2. Plan: control en 1 mes.',
      }),
    ]);
    await day(harness, 2, [
      consultation({
        patient,
        id: 'sp-e2',
        at: 2,
        specialty: 'gynecology',
        note: 'Control ginecologico anual. Sin hallazgos.',
      }),
    ]);
    let snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup')).toHaveLength(1);
    expect(rule(snapshot, 'doctor_plan_followup')[0]?.status).toBe('open');
    // The gynecology visit neither fulfills the plan nor re-anchors the diabetes protocol.
    expect(rule(snapshot, 'protocol_diabetes_visit').map((e) => e.source.id)).not.toContain(
      'sp-e2',
    );

    await days(harness, 3, 31);
    expect(await activeRuleIds(harness, patient)).toContainEqual(['doctor_plan_followup']);

    // The diabetology control, late, fulfills it.
    await day(harness, 33, [
      consultation({ patient, id: 'sp-e3', at: 33, specialty: 'diabetology' }),
    ]);
    snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup')[0]).toMatchObject({
      status: 'fulfilled',
      closedBy: { resourceType: 'Encounter', id: 'sp-e3' },
    });
  });

  it('the treating practitioner fulfills a follow-up whatever the specialty label', async () => {
    const harness = await makeHarness(options('same-practitioner'));
    const patient = 'p-practitioner';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'pr-e1',
        at: 0,
        specialty: 'internal_medicine',
        practitionerId: 'dr-1',
        note: 'Plan: control en 1 mes.',
      }),
    ]);
    await day(harness, 25, [
      consultation({
        patient,
        id: 'pr-e2',
        at: 25,
        specialty: 'general_practice',
        practitionerId: 'dr-1',
      }),
    ]);
    const snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup')[0]?.status).toBe('fulfilled');
  });

  it('cancelling a booking also withdraws the protocol visit anchored on it', async () => {
    const harness = await makeHarness(options('cancel-protocol'));
    const patient = 'p-cancel-protocol';
    await day(harness, 0, [
      consultation({
        patient,
        id: 'cp-e1',
        at: 0,
        specialty: 'diabetology',
        note: 'DM2 en control. Plan: control en 2 meses.',
      }),
    ]);
    const booking = {
      id: 'cp-ap1',
      patientId: patient,
      specialty: 'diabetology',
      start: dayToDate(55),
      bookedAt: dayToDate(3),
    };
    await day(harness, 3, [transactionOf(appointmentResource({ ...booking, at: dayToDate(3) }))]);
    let snapshot = await snapshotPatient(harness, patientId(patient));
    expect(rule(snapshot, 'doctor_plan_followup').map((e) => e.status)).toEqual(['fulfilled']);
    expect(
      rule(snapshot, 'protocol_diabetes_visit')
        .filter((e) => e.status === 'open')
        .map((e) => e.source.id),
    ).toEqual(['cp-ap1']);

    await day(harness, 10, [
      transactionOf(
        appointmentResource({ ...booking, status: 'cancelled', version: 2, at: dayToDate(10) }),
      ),
    ]);
    snapshot = await snapshotPatient(harness, patientId(patient));
    // The plan is open again and covers the visit: no protocol visit is left in play.
    expect(rule(snapshot, 'doctor_plan_followup').map((e) => e.status)).toEqual(['open']);
    const visits = rule(snapshot, 'protocol_diabetes_visit');
    expect(visits.filter((e) => e.status === 'open')).toEqual([]);
    expect(visits.find((e) => e.source.id === 'cp-ap1')).toMatchObject({
      status: 'cancelled',
      closedReason: 'source_withdrawn',
    });
  });
}

describe('fulfillment (memory)', () => {
  fulfillment((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('fulfillment'), () => {
  const database = useIsolatedDatabase();
  fulfillment((options) => postgresHarness(database(), options));
});
