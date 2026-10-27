import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  type CaseAction,
  type CaseId,
  clinicId,
  type FollowUpCase,
  InvalidCaseTransitionError,
  isActiveCaseStatus,
  patientId,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { labOrderResource, transactionOf } from '../src/bundles.ts';
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
 * HIP-119: two users act on the same case at the same time. One action
 * wins; the other gets the same typed error it would get afterwards
 * (`InvalidCaseTransitionError`, HTTP 409) and leaves no trace: one
 * transition, one `case.resolved` webhook.
 */

const USERS = ['u1', 'u2', 'u3', 'u4'] as const;

async function openCase(harness: EngineHarness, patient: string): Promise<CaseId> {
  harness.clock.set(dayToDate(0));
  await ingestBundle(
    harness,
    transactionOf(
      labOrderResource({
        id: `sr-${patient}`,
        patientId: patient,
        loinc: '2160-0',
        at: dayToDate(0),
      }),
    ),
    dayToDate(0),
  );
  harness.clock.set(dayToDate(16));
  await harness.engine.runWatcher(harness.clinicId, dayToDate(16));
  const [followUpCase] = (await snapshotPatient(harness, patientId(patient))).cases;
  if (followUpCase === undefined) {
    throw new Error('expected a case');
  }
  return followUpCase.id;
}

async function race(
  harness: EngineHarness,
  caseId: CaseId,
  actions: readonly CaseAction[],
): Promise<PromiseSettledResult<FollowUpCase>[]> {
  return Promise.allSettled(
    actions.map((action, index) =>
      harness.engine.cases.apply(harness.clinicId, caseId, action, {
        type: 'user',
        id: USERS[index] ?? 'u',
      }),
    ),
  );
}

function concurrency(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-concurrency-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('concurrent resolves: one wins, the others get a typed conflict, one webhook', async () => {
    const harness = await makeHarness(options('resolve'));
    for (const [round, patient] of ['p-c1', 'p-c2', 'p-c3'].entries()) {
      const caseId = await openCase(harness, patient);
      const results = await race(
        harness,
        caseId,
        USERS.map(() => ({ type: 'resolve' as const })),
      );
      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.flatMap((result): unknown[] =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      expect(won, `round ${String(round)}`).toHaveLength(1);
      expect(lost).toHaveLength(USERS.length - 1);
      for (const error of lost) {
        expect(error).toBeInstanceOf(InvalidCaseTransitionError);
      }
      const audit = await harness.read((stores) =>
        stores.audit.listForCase(harness.clinicId, caseId),
      );
      expect(audit.filter((event) => event.type === 'resolved')).toHaveLength(1);
      const resolved = (await harness.pendingEvents()).filter(
        (event) => event.type === 'case.resolved' && event.payload.caseId === caseId,
      );
      expect(resolved).toHaveLength(1);
    }
  });

  it('resolve against dismiss: the response of the winner is the final state', async () => {
    const harness = await makeHarness(options('resolve-dismiss'));
    const caseId = await openCase(harness, 'p-rd');
    const results = await race(harness, caseId, [
      { type: 'resolve' },
      { type: 'dismiss' },
      { type: 'resolve', kind: 'not_needed' },
    ]);
    const won = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(won).toHaveLength(1);
    const final = await harness.read((stores) => stores.cases.get(harness.clinicId, caseId));
    expect(final?.status).toBe(won[0]?.status);
    expect(isActiveCaseStatus(final?.status ?? 'open')).toBe(false);
    const resolved = (await harness.pendingEvents()).filter(
      (event) => event.type === 'case.resolved' && event.payload.caseId === caseId,
    );
    expect(resolved).toHaveLength(1);
  });

  it('a user action racing the escalation sweep is not overwritten', async () => {
    const harness = await makeHarness(options('sweep'));
    const caseId = await openCase(harness, 'p-sweep');
    await harness.engine.runEscalation(harness.clinicId, dayToDate(16));
    harness.clock.set(dayToDate(31));
    const [dismissed] = await Promise.allSettled([
      harness.engine.cases.dismiss(harness.clinicId, caseId, { type: 'user', id: 'u1' }),
      harness.engine.runEscalation(harness.clinicId, dayToDate(31)),
    ]);
    expect(dismissed.status).toBe('fulfilled');
    const final = await harness.read((stores) => stores.cases.get(harness.clinicId, caseId));
    expect(final?.status).toBe('dismissed');
  });
}

describe('concurrent case actions (memory)', () => {
  concurrency((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('concurrent case actions'), () => {
  const database = useIsolatedDatabase();
  concurrency((options) => postgresHarness(database(), options));
});
