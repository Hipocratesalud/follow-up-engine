import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  patientId,
  type PatientCondition,
} from '@follow-up-engine/core';
import { patientConditionToFhir } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  conditionResource,
  encounterResource,
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
 * HIP-132: withdrawn and moved records. A diagnosis the host refutes is
 * stored as rejected (by the host) and exported `refuted`; one entered in
 * error or moved to another patient is withdrawn from that patient
 * (`entered-in-error`); a note moved to the right patient takes its plan
 * along; a diagnosis another active record still asserts stays.
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

function live(expectations: readonly Expectation[], protocol: string): Expectation[] {
  return expectations.filter(
    (e) => e.protocolId === protocol && (e.status === 'open' || e.status === 'expired'),
  );
}

async function conditionsOf(harness: EngineHarness, patient: string) {
  return harness.read((stores) =>
    stores.conditions.listByPatient(harness.clinicId, patientId(patient)),
  );
}

function exported(condition: PatientCondition | undefined) {
  if (condition === undefined) {
    throw new Error('expected a stored condition');
  }
  const fhir = patientConditionToFhir(condition);
  return {
    verification: fhir.verificationStatus?.coding?.[0]?.code,
    clinical: fhir.clinicalStatus?.coding?.[0]?.code,
  };
}

function withdrawnRecords(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-withdrawn-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('a diagnosis the host refutes is rejected by the host and exported refuted', async () => {
    const harness = await makeHarness(options('refuted'));
    const patient = 'p-host-refuted';
    const diagnosis = { id: 'hr-dx', patientId: patient, icd10: 'I10' };
    await day(harness, 0, [
      transactionOf(
        conditionResource({ ...diagnosis, verification: 'confirmed', at: dayToDate(0) }),
      ),
    ]);
    await day(harness, 2, [
      transactionOf(
        conditionResource({
          ...diagnosis,
          verification: 'refuted',
          version: 2,
          recordedDate: dayToDate(0),
          at: dayToDate(2),
        }),
      ),
    ]);
    const [condition] = await conditionsOf(harness, patient);
    expect(condition).toMatchObject({ status: 'rejected', confidence: 0 });
    expect(condition?.confirmedBy).toBeUndefined();
    expect(exported(condition)).toEqual({
      verification: 'refuted',
      clinical: 'inactive',
    });
  });

  it('a diagnosis entered in error is withdrawn and exported entered-in-error', async () => {
    const harness = await makeHarness(options('in-error'));
    const patient = 'p-dx-error';
    const diagnosis = { id: 'de-dx', patientId: patient, icd10: 'E11.9' };
    await day(harness, 0, [
      transactionOf(
        conditionResource({ ...diagnosis, verification: 'confirmed', at: dayToDate(0) }),
      ),
    ]);
    await day(harness, 2, [
      transactionOf(
        conditionResource({
          ...diagnosis,
          verification: 'entered-in-error',
          version: 2,
          recordedDate: dayToDate(0),
          at: dayToDate(2),
        }),
      ),
    ]);
    const [condition] = await conditionsOf(harness, patient);
    expect(condition).toMatchObject({ status: 'entered_in_error', confidence: 0 });
    expect(exported(condition)).toEqual({
      verification: 'entered-in-error',
      clinical: undefined,
    });
    expect(
      live((await snapshotPatient(harness, patientId(patient))).expectations, 'diabetes'),
    ).toEqual([]);
  });

  it('a diagnosis moved to another patient leaves nothing confirmed on the wrong one', async () => {
    const harness = await makeHarness(options('moved-dx'));
    const diagnosis = { id: 'mv-dx', icd10: 'I10', verification: 'confirmed' as const };
    await day(harness, 0, [
      transactionOf(conditionResource({ ...diagnosis, patientId: 'p-mv-wrong', at: dayToDate(0) })),
    ]);
    await day(harness, 1, [
      transactionOf(
        conditionResource({
          ...diagnosis,
          patientId: 'p-mv-right',
          version: 2,
          recordedDate: dayToDate(0),
          at: dayToDate(1),
        }),
      ),
    ]);
    const [wrong] = await conditionsOf(harness, 'p-mv-wrong');
    expect(wrong).toMatchObject({ status: 'entered_in_error' });
    expect(exported(wrong).verification).toBe('entered-in-error');
    expect((await conditionsOf(harness, 'p-mv-right')).map((c) => c.status)).toEqual(['confirmed']);
  });

  it('a note moved to the right patient takes its plan along', async () => {
    const harness = await makeHarness(options('moved-note'));
    const note = {
      id: 'mvn-note',
      specialty: 'internal_medicine',
      text: 'Paciente estable.\nPlan: control en 2 semanas.',
    };
    await day(harness, 0, [
      transactionOf(noteResource({ ...note, patientId: 'p-mvn-wrong', at: dayToDate(0) })),
    ]);
    await day(harness, 0, [
      transactionOf(
        noteResource({ ...note, patientId: 'p-mvn-right', version: 2, at: dayToDate(0) }),
      ),
    ]);
    const wrong = await snapshotPatient(harness, patientId('p-mvn-wrong'));
    const right = await snapshotPatient(harness, patientId('p-mvn-right'));
    expect(
      wrong.expectations.filter((e) => e.ruleId === 'doctor_plan_followup').map((e) => e.status),
    ).toEqual(['cancelled']);
    expect(
      right.expectations.filter((e) => e.ruleId === 'doctor_plan_followup').map((e) => e.status),
    ).toEqual(['open']);
    await days(harness, 1, 16);
    const cases = (await snapshotPatient(harness, patientId('p-mvn-right'))).cases.filter((c) =>
      isActiveCaseStatus(c.status),
    );
    expect(cases.map((c) => c.ruleIds)).toEqual([['doctor_plan_followup']]);
  });

  it.each([
    ['the older', 'w4b-c1'],
    ['the newer', 'w4b-c2'],
  ])(
    'withdrawing %s of two records of the same diagnosis keeps the patient enrolled',
    async (_label, withdrawn) => {
      const harness = await makeHarness(options(`duplicate-${withdrawn}`));
      const patient = `p-${withdrawn}`;
      const record = (id: string, at: number) =>
        conditionResource({
          id: `${patient}-${id}`,
          patientId: patient,
          icd10: 'E11.9',
          verification: 'confirmed',
          at: dayToDate(at),
        });
      await day(harness, -30, [
        transactionOf(
          encounterResource({
            id: `${patient}-e1`,
            patientId: patient,
            specialty: 'diabetology',
            at: dayToDate(-30),
          }),
          record('w4b-c1', -30),
        ),
      ]);
      await day(harness, 0, [
        transactionOf(
          encounterResource({
            id: `${patient}-e2`,
            patientId: patient,
            specialty: 'diabetology',
            at: dayToDate(0),
          }),
          record('w4b-c2', 0),
        ),
      ]);
      const before = live(
        (await snapshotPatient(harness, patientId(patient))).expectations,
        'diabetes',
      );
      expect(before).not.toEqual([]);
      await day(harness, 4, [
        transactionOf(
          conditionResource({
            id: `${patient}-${withdrawn}`,
            patientId: patient,
            icd10: 'E11.9',
            verification: 'entered-in-error',
            version: 2,
            recordedDate: dayToDate(withdrawn === 'w4b-c1' ? -30 : 0),
            at: dayToDate(4),
          }),
        ),
      ]);
      const after = live(
        (await snapshotPatient(harness, patientId(patient))).expectations,
        'diabetes',
      );
      expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
      expect((await conditionsOf(harness, patient)).map((c) => c.status)).toEqual(['confirmed']);
    },
  );
}

describe('withdrawn and moved records (memory)', () => {
  withdrawnRecords((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('withdrawn and moved records'), () => {
  const database = useIsolatedDatabase();
  withdrawnRecords((options) => postgresHarness(database(), options));
});
