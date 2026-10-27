import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type FollowUpCase, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { labOrderResource, observationResource, transactionOf } from '../src/bundles.ts';
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
 * HIP-124 (remaining): a critical (panic) result is due the next day and
 * ranks urgent from the start, above a mild abnormality; escalation raises
 * respect the cap of the case's category, so a result ordered long ago never
 * outranks a fresh critical value.
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

async function activeCases(harness: EngineHarness, patient: string): Promise<FollowUpCase[]> {
  return (await snapshotPatient(harness, patientId(patient))).cases.filter((c) =>
    isActiveCaseStatus(c.status),
  );
}

function potassium(id: string, patient: string, value: number, flag: 'H' | 'HH', at: number) {
  return transactionOf(
    observationResource({
      id,
      patientId: patient,
      loinc: '2823-3',
      value,
      unit: 'mmol/L',
      interpretation: flag,
      at: dayToDate(at),
    }),
  );
}

function severity(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-severity-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('a critical result is due the next day and ranks urgent above a mild one', async () => {
    const harness = await makeHarness(options('critical'));
    await day(harness, 1, [
      potassium('k-critical', 'p-k1', 6.8, 'HH', 1),
      potassium('k-mild', 'p-k2', 5.3, 'H', 1),
    ]);
    const critical = (await snapshotPatient(harness, patientId('p-k1'))).expectations;
    expect(critical.map((e) => [e.ruleId, e.dueAt.getTime()])).toEqual([
      ['abnormal_result_followup', dayToDate(2).getTime()],
    ]);
    const mild = (await snapshotPatient(harness, patientId('p-k2'))).expectations;
    expect(mild.map((e) => e.dueAt.getTime())).toEqual([dayToDate(8).getTime()]);

    await day(harness, 2);
    const [criticalCase] = await activeCases(harness, 'p-k1');
    expect(criticalCase?.priority).toBeGreaterThanOrEqual(90);
    expect(await activeCases(harness, 'p-k2')).toEqual([]);
    for (let n = 3; n <= 9; n += 1) await day(harness, n);
    const [mildCase] = await activeCases(harness, 'p-k2');
    expect(mildCase?.priority).toBeLessThan(90);
    expect((await activeCases(harness, 'p-k1'))[0]?.priority).toBeGreaterThan(
      mildCase?.priority ?? 100,
    );
  });

  it('an escalated pending result stays below urgent and below a fresh critical result', async () => {
    const harness = await makeHarness(options('caps'));
    await day(harness, 0, [
      transactionOf(
        labOrderResource({ id: 'cap-sr1', patientId: 'p-cap', loinc: '2160-0', at: dayToDate(0) }),
        labOrderResource({ id: 'cap-sr2', patientId: 'p-cap', loinc: '718-7', at: dayToDate(0) }),
        labOrderResource({ id: 'cap-sr3', patientId: 'p-cap', loinc: '2093-3', at: dayToDate(0) }),
      ),
    ]);
    for (let n = 1; n <= 40; n += 1) await day(harness, n);
    const [pending] = await activeCases(harness, 'p-cap');
    expect(pending?.escalationStep).toBeGreaterThanOrEqual(2);
    expect(pending?.priority).toBeLessThanOrEqual(89);
    await day(harness, 41, [potassium('k-fresh', 'p-fresh', 6.9, 'HH', 41)]);
    await day(harness, 42);
    const [fresh] = await activeCases(harness, 'p-fresh');
    expect(fresh?.priority).toBeGreaterThan(pending?.priority ?? 100);
  });
}

describe('result severity and priority caps (memory)', () => {
  severity((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('result severity and priority caps'), () => {
  const database = useIsolatedDatabase();
  severity((options) => postgresHarness(database(), options));
});
