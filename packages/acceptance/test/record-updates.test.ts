import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  conditionResource,
  encounterResource,
  labOrderResource,
  noteResource,
  observationResource,
  patientResource,
  prescriptionResource,
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
 * HIP-116: a host sends a new version of a resource it already sent. A
 * withdrawn order, prescription, diagnosis or note withdraws what the engine
 * derived from it; a corrected subject moves the follow-up to the right
 * patient; an older version delivered late changes nothing; an amended note
 * replaces its plan.
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

function byRule(expectations: readonly Expectation[], ruleId: string): Expectation[] {
  return expectations.filter((expectation) => expectation.ruleId === ruleId);
}

async function snapshot(harness: EngineHarness, patient: string) {
  return snapshotPatient(harness, patientId(patient));
}

async function activeCases(harness: EngineHarness, patient: string) {
  return (await snapshot(harness, patient)).cases.filter((c) => isActiveCaseStatus(c.status));
}

function recordUpdates(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-updates-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
    settings: { allowPatientContact: true },
  });

  it.each(['revoked', 'entered-in-error'] as const)(
    'a %s order cancels its expectation and resolves its case',
    async (status) => {
      const harness = await makeHarness(options(`order-${status}`));
      const patient = `p-order-${status}`;
      const order = { id: `sr-${status}`, patientId: patient, loinc: '2160-0' };
      await day(harness, 0, [transactionOf(labOrderResource({ ...order, at: dayToDate(0) }))]);
      await day(harness, 2, [
        transactionOf(labOrderResource({ ...order, status, version: 2, at: dayToDate(2) })),
      ]);
      const after = await snapshot(harness, patient);
      expect(byRule(after.expectations, 'lab_order_result_pending')).toMatchObject([
        { status: 'cancelled', closedReason: 'source_withdrawn' },
      ]);
      await days(harness, 3, 20);
      expect(await activeCases(harness, patient)).toEqual([]);

      // Withdrawn after its case opened: the case resolves as not needed.
      const late = { id: `sr-late-${status}`, patientId: patient, loinc: '718-7' };
      await day(harness, 21, [transactionOf(labOrderResource({ ...late, at: dayToDate(21) }))]);
      await days(harness, 22, 37);
      expect((await activeCases(harness, patient)).map((c) => c.ruleIds)).toEqual([
        ['lab_order_result_pending'],
      ]);
      await day(harness, 38, [
        transactionOf(labOrderResource({ ...late, status, version: 2, at: dayToDate(38) })),
      ]);
      const resolved = await snapshot(harness, patient);
      expect(resolved.cases.filter((c) => isActiveCaseStatus(c.status))).toEqual([]);
      expect(resolved.cases.map((c) => c.resolution?.kind)).toEqual(['not_needed']);
    },
  );

  it('a stopped prescription produces no end-of-treatment case', async () => {
    const harness = await makeHarness(options('stopped'));
    const patient = 'p-stopped';
    const prescription = {
      id: 'mr-stopped',
      patientId: patient,
      text: 'Amoxicilina 500 mg',
      durationDays: 5,
    };
    await day(harness, 0, [
      transactionOf(prescriptionResource({ ...prescription, at: dayToDate(0) })),
    ]);
    await day(harness, 1, [
      transactionOf(
        prescriptionResource({ ...prescription, status: 'stopped', version: 2, at: dayToDate(1) }),
      ),
    ]);
    await days(harness, 2, 20);
    const after = await snapshot(harness, patient);
    expect(byRule(after.expectations, 'short_treatment_followup')).toMatchObject([
      { status: 'cancelled', closedReason: 'source_withdrawn' },
    ]);
    expect(await activeCases(harness, patient)).toEqual([]);
  });

  it('a refuted diagnosis un-enrolls the patient from its protocol', async () => {
    const harness = await makeHarness(options('refuted'));
    const patient = 'p-refuted';
    const diagnosis = { id: 'dx-refuted', patientId: patient, icd10: 'E11.9' };
    await day(harness, 0, [
      transactionOf(
        conditionResource({ ...diagnosis, verification: 'provisional', at: dayToDate(0) }),
      ),
    ]);
    let after = await snapshot(harness, patient);
    expect(
      after.expectations.filter((e) => e.protocolId === 'diabetes' && e.status === 'open'),
    ).not.toEqual([]);
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
    after = await snapshot(harness, patient);
    expect(
      after.expectations.filter((e) => e.protocolId === 'diabetes' && e.status === 'open'),
    ).toEqual([]);
    const conditions = await harness.read((stores) =>
      stores.conditions.listByPatient(harness.clinicId, patientId(patient)),
    );
    // Refuted by the host: the patient does not have it (exported `refuted`).
    expect(conditions.map((c) => c.status)).toEqual(['rejected']);
    await days(harness, 3, 100);
    expect(await activeCases(harness, patient)).toEqual([]);
  });

  it('a corrected subject moves the expectation to the right patient', async () => {
    const harness = await makeHarness(options('subject'));
    const order = { id: 'sr-moved', loinc: '24627-2' };
    await day(harness, 0, [
      transactionOf(labOrderResource({ ...order, patientId: 'p-wrong', at: dayToDate(0) })),
    ]);
    await day(harness, 1, [
      transactionOf(
        labOrderResource({
          ...order,
          patientId: 'p-right',
          version: 2,
          authoredOn: dayToDate(0),
          at: dayToDate(1),
        }),
      ),
    ]);
    const wrong = await snapshot(harness, 'p-wrong');
    const right = await snapshot(harness, 'p-right');
    expect(byRule(wrong.expectations, 'lab_order_result_pending')).toMatchObject([
      { status: 'cancelled' },
    ]);
    expect(byRule(right.expectations, 'lab_order_result_pending')).toMatchObject([
      { status: 'open', source: { resourceType: 'ServiceRequest', id: 'sr-moved' } },
    ]);
    await days(harness, 2, 17);
    expect(await activeCases(harness, 'p-wrong')).toEqual([]);
    expect((await activeCases(harness, 'p-right')).map((c) => c.ruleIds)).toEqual([
      ['lab_order_result_pending'],
    ]);
  });

  it('an older version delivered late is ignored', async () => {
    const harness = await makeHarness(options('stale'));
    await day(harness, 0, [
      transactionOf(
        patientResource({ id: 'p-stale', family: 'Nuevo', version: 5, at: dayToDate(0) }),
      ),
    ]);
    await day(harness, 1, [
      transactionOf(
        patientResource({ id: 'p-stale', family: 'Viejo', version: 3, at: dayToDate(-30) }),
      ),
    ]);
    const stored = await harness.read((stores) =>
      stores.clinicalRecords.getResource(harness.clinicId, {
        resourceType: 'Patient',
        id: 'p-stale',
      }),
    );
    expect(stored?.resource['name']).toEqual([{ family: 'Nuevo' }]);

    // A revoked order followed by its late, older active version stays revoked.
    const order = { id: 'sr-stale', patientId: 'p-stale', loinc: '2160-0' };
    await day(harness, 2, [
      transactionOf(
        labOrderResource({ ...order, status: 'revoked', version: 2, at: dayToDate(2) }),
      ),
    ]);
    await day(harness, 3, [
      transactionOf(
        labOrderResource({ ...order, version: 1, authoredOn: dayToDate(1), at: dayToDate(1) }),
      ),
    ]);
    await days(harness, 4, 20);
    const after = await snapshot(harness, 'p-stale');
    expect(byRule(after.expectations, 'lab_order_result_pending')).toEqual([]);
    expect(await activeCases(harness, 'p-stale')).toEqual([]);
  });

  it('an amended note replaces the plan it amends', async () => {
    const harness = await makeHarness(options('amended'));
    const patient = 'p-amended';
    const note = {
      id: 'am-note',
      patientId: patient,
      encounterId: 'am-e1',
      specialty: 'internal_medicine',
    };
    await day(harness, 0, [
      transactionOf(
        encounterResource({
          id: 'am-e1',
          patientId: patient,
          specialty: 'internal_medicine',
          at: dayToDate(0),
        }),
        noteResource({ ...note, text: 'Plan: control en 1 mes.', at: dayToDate(0) }),
      ),
    ]);
    await day(harness, 1, [
      transactionOf(
        noteResource({
          ...note,
          text: 'Plan: control en 3 meses (corregido).',
          docStatus: 'amended',
          version: 2,
          at: dayToDate(1),
        }),
      ),
    ]);
    let after = await snapshot(harness, patient);
    const plans = byRule(after.expectations, 'doctor_plan_followup');
    // "3 meses" from the amended note's date (day 1).
    expect(plans.find((e) => e.status === 'open')?.dueAt.getTime()).toBe(dayToDate(91).getTime());
    expect(plans.find((e) => e.dueAt.getTime() === dayToDate(30).getTime())).toMatchObject({
      status: 'superseded',
      closedReason: 'superseded_by_amended_note',
    });
    await days(harness, 2, 40);
    expect(await activeCases(harness, patient)).toEqual([]);

    // A replacement document (relatesTo replaces) does the same.
    await day(harness, 41, [
      transactionOf(
        noteResource({
          id: 'am-note-2',
          patientId: patient,
          encounterId: 'am-e1',
          specialty: 'internal_medicine',
          text: 'Plan: control en 2 meses.',
          replaces: ['am-note'],
          at: dayToDate(41),
        }),
      ),
    ]);
    after = await snapshot(harness, patient);
    expect(
      byRule(after.expectations, 'doctor_plan_followup')
        .filter((e) => e.status === 'open')
        .map((e) => e.source.id),
    ).toEqual(['am-note-2']);
  });

  it('a result entered in error reopens the order it had fulfilled', async () => {
    const harness = await makeHarness(options('result-error'));
    const patient = 'p-result-error';
    await day(harness, 0, [
      transactionOf(
        labOrderResource({ id: 'sr-re', patientId: patient, loinc: '2160-0', at: dayToDate(0) }),
      ),
    ]);
    const result = {
      id: 'obs-re',
      patientId: patient,
      loinc: '2160-0',
      value: 1.0,
      unit: 'mg/dL',
      interpretation: 'N' as const,
      basedOn: 'sr-re',
    };
    await day(harness, 3, [transactionOf(observationResource({ ...result, at: dayToDate(3) }))]);
    expect(
      byRule((await snapshot(harness, patient)).expectations, 'lab_order_result_pending'),
    ).toMatchObject([{ status: 'fulfilled' }]);
    await day(harness, 5, [
      transactionOf(
        observationResource({
          ...result,
          status: 'entered-in-error',
          version: 2,
          at: dayToDate(5),
        }),
      ),
    ]);
    expect(
      byRule((await snapshot(harness, patient)).expectations, 'lab_order_result_pending'),
    ).toMatchObject([{ status: 'open' }]);
  });
}

describe('updates to resources already sent (memory)', () => {
  recordUpdates((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('updates to resources already sent'), () => {
  const database = useIsolatedDatabase();
  recordUpdates((options) => postgresHarness(database(), options));
});
