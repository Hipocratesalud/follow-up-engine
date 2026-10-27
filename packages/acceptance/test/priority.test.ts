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
 * HIP-124: the case priority follows the clinical model and the calendar: a
 * doctor-ordered result outranks a protocol reminder built on a probable
 * condition, an abnormal result outranks both, and the overdue factor is
 * recomputed on every tick instead of frozen at opening.
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

async function activeCase(harness: EngineHarness, patient: string): Promise<FollowUpCase> {
  const cases = (await snapshotPatient(harness, patientId(patient))).cases.filter((c) =>
    isActiveCaseStatus(c.status),
  );
  expect(cases).toHaveLength(1);
  return cases[0] as FollowUpCase;
}

function priority(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  it('ranks abnormal > ordered result > probable protocol reminder, and follows the calendar', async () => {
    const harness = await makeHarness({
      clinicId: clinicId(`clinic-priority-${String(Date.now())}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
    });
    // Probable diabetes from an HbA1c 6.7 (no diagnosis) 100 days ago.
    await day(harness, -100, [
      transactionOf(
        observationResource({
          id: 'obs-probable',
          patientId: 'p-probable',
          loinc: '4548-4',
          value: 6.7,
          unit: '%',
          at: dayToDate(-100),
        }),
      ),
    ]);
    await day(harness, 0, [
      transactionOf(
        labOrderResource({
          id: 'sr-ordered',
          patientId: 'p-ordered',
          loinc: '2160-0',
          at: dayToDate(0),
        }),
      ),
    ]);
    await day(harness, 9, [
      transactionOf(
        observationResource({
          id: 'obs-abnormal',
          patientId: 'p-abnormal',
          loinc: '2823-3',
          value: 6.4,
          unit: 'mmol/L',
          interpretation: 'HH',
          at: dayToDate(9),
        }),
      ),
    ]);
    for (let n = 1; n <= 16; n += 1) {
      if (n !== 9) await day(harness, n);
    }
    const ordered = await activeCase(harness, 'p-ordered');
    const probable = await activeCase(harness, 'p-probable');
    const abnormal = await activeCase(harness, 'p-abnormal');
    expect(abnormal.priority).toBeGreaterThan(ordered.priority);
    expect(ordered.priority).toBeGreaterThan(probable.priority);
    expect(ordered.priority).toBeGreaterThanOrEqual(60);
    expect(probable.priority).toBeLessThan(60);

    // Ten days later, nobody acted and no escalation step ran yet: the
    // overdue factor grew on its own.
    for (let n = 17; n <= 26; n += 1) await day(harness, n);
    expect((await activeCase(harness, 'p-ordered')).priority).toBeGreaterThan(ordered.priority);
  });
}

describe('case priority (memory)', () => {
  priority((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('case priority'), () => {
  const database = useIsolatedDatabase();
  priority((options) => postgresHarness(database(), options));
});
