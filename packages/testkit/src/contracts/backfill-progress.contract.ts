import {
  type BackfillCounts,
  type BackfillProgressStore,
  patientId,
  ZERO_BACKFILL_COUNTS,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

function counts(overrides: Partial<BackfillCounts>): BackfillCounts {
  return { ...ZERO_BACKFILL_COUNTS, ...overrides };
}

/** Contract every {@link BackfillProgressStore} adapter must pass. */
export function describeBackfillProgressStoreContract(
  name: string,
  makeSubject: MakeSubject<BackfillProgressStore>,
): void {
  describe(`BackfillProgressStore contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const store = () => current().subject;

    it('starts a running run with zero counters and reads it back', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      const started = await store().start(a, runId, { now: at(0), shadow: true });
      expect(started).toEqual({
        clinicId: a,
        runId,
        status: 'running',
        shadow: true,
        ...ZERO_BACKFILL_COUNTS,
        startedAt: at(0),
        updatedAt: at(0),
      });
      expect(await store().get(a, runId)).toEqual(started);
      expect(await store().findRunning(a)).toEqual(started);
    });

    it('allows one unfinished run per clinic', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { now: at(0) });
      await expectRejectsWithName(
        store().start(a, uniqueId('run'), { now: at(1) }),
        'ConflictError',
      );
      await store().pause(a, runId, { reason: 'llm_budget_exceeded', now: at(1) });
      await expectRejectsWithName(
        store().start(a, uniqueId('run'), { now: at(2) }),
        'ConflictError',
      );
      await store().finish(a, runId, { status: 'completed', now: at(3) });
      expect(await store().findRunning(a)).toBeUndefined();
      await store().start(a, uniqueId('run'), { now: at(4) });
      await expectRejectsWithName(store().start(a, runId, { now: at(5) }), 'ConflictError');
    });

    it('advances the cursor and adds to every counter', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { now: at(0) });
      await store().advance(a, runId, {
        cursor: patientId('pat-0001'),
        delta: counts({
          patientsScanned: 1,
          eventsProcessed: 12,
          documentsProcessed: 3,
          expectationsCreated: 5,
          expectationsFulfilled: 4,
          casesOpened: 1,
          llmCostUsd: 0.0025,
        }),
        now: at(1),
      });
      const advanced = await store().advance(a, runId, {
        cursor: patientId('pat-0002'),
        delta: counts({ patientsScanned: 1, eventsProcessed: 3, llmCostUsd: 0.0005 }),
        now: at(2),
      });
      expect(advanced).toMatchObject({
        cursor: 'pat-0002',
        patientsScanned: 2,
        eventsProcessed: 15,
        documentsProcessed: 3,
        expectationsCreated: 5,
        expectationsFulfilled: 4,
        casesOpened: 1,
        updatedAt: at(2),
      });
      expect(advanced.llmCostUsd).toBeCloseTo(0.003, 10);
      expect(await store().get(a, runId)).toEqual(advanced);
    });

    it('pauses on budget, resumes, and only advances a running run', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { now: at(0) });
      const paused = await store().pause(a, runId, { reason: 'llm_budget_exceeded', now: at(1) });
      expect(paused).toMatchObject({ status: 'paused_budget', lastError: 'llm_budget_exceeded' });
      expect((await store().findRunning(a))?.status).toBe('paused_budget');
      await expectRejectsWithName(
        store().advance(a, runId, { cursor: patientId('p'), delta: counts({}), now: at(2) }),
        'NotFoundError',
      );
      const resumed = await store().resume(a, runId, at(3));
      expect(resumed.status).toBe('running');
      expect(resumed.lastError).toBeUndefined();
    });

    it('finishes once; a finished run cannot change', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { now: at(0) });
      const failed = await store().finish(a, runId, {
        status: 'failed',
        error: 'boom',
        now: at(1),
      });
      expect(failed).toMatchObject({
        status: 'failed',
        lastError: 'boom',
        finishedAt: at(1),
      });
      await expectRejectsWithName(
        store().finish(a, runId, { status: 'completed', now: at(2) }),
        'NotFoundError',
      );
      await expectRejectsWithName(store().resume(a, runId, at(2)), 'NotFoundError');
      await expectRejectsWithName(
        store().pause(a, runId, { reason: 'x', now: at(2) }),
        'NotFoundError',
      );
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { now: at(0) });
      expect(await store().get(b, runId)).toBeUndefined();
      expect(await store().findRunning(b)).toBeUndefined();
      await expectRejectsWithName(
        store().advance(b, runId, { cursor: patientId('p'), delta: counts({}), now: at(1) }),
        'NotFoundError',
      );
      // The same run id is independent per clinic, and B may run concurrently.
      await store().start(b, runId, { now: at(0) });
      expect((await store().findRunning(a))?.clinicId).toBe(a);
    });
  });
}
