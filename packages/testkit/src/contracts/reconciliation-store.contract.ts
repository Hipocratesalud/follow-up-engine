import {
  patientId,
  RECONCILIATION_ACTOR,
  type ReconciliationRepair,
  type ReconciliationStore,
  ZERO_RECONCILIATION_COUNTS,
} from '@follow-up-engine/core';
import type { ClinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

function aRepair(
  clinic: ClinicId,
  runId: string,
  overrides: Partial<ReconciliationRepair> = {},
): ReconciliationRepair {
  return {
    clinicId: clinic,
    runId,
    patientId: patientId('pat-0001'),
    kind: 'expectation_fulfilled',
    entityId: uniqueId('exp'),
    ruleId: 'lab_order_result_pending',
    from: 'expired',
    to: 'fulfilled',
    detail: 'fulfilled_by_result',
    actor: RECONCILIATION_ACTOR,
    reason: 'reconciliation',
    at: at(1),
    ...overrides,
  };
}

/** Contract every {@link ReconciliationStore} adapter must pass (HIP-141). */
export function describeReconciliationStoreContract(
  name: string,
  makeSubject: MakeSubject<ReconciliationStore>,
): void {
  describe(`ReconciliationStore contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const store = () => current().subject;

    it('starts a running run with zero counters and reads it back', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      const started = await store().start(a, runId, {
        scope: 'recent',
        since: '41',
        watermark: '97',
        now: at(0),
      });
      expect(started).toEqual({
        clinicId: a,
        runId,
        scope: 'recent',
        status: 'running',
        since: '41',
        watermark: '97',
        ...ZERO_RECONCILIATION_COUNTS,
        startedAt: at(0),
        updatedAt: at(0),
      });
      expect(await store().get(a, runId)).toEqual(started);
      expect(await store().findRunning(a)).toEqual(started);
      expect(await store().lastCompleted(a)).toBeUndefined();
    });

    it('allows one unfinished run per clinic and never reuses a run id', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { scope: 'all', now: at(0) });
      await expectRejectsWithName(
        store().start(a, uniqueId('run'), { scope: 'all', now: at(1) }),
        'ConflictError',
      );
      await store().finish(a, runId, { status: 'completed', now: at(2) });
      expect(await store().findRunning(a)).toBeUndefined();
      await expectRejectsWithName(
        store().start(a, runId, { scope: 'all', now: at(3) }),
        'ConflictError',
      );
    });

    it('advances the cursor and adds to every counter, by repair kind too', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { scope: 'all', now: at(0) });
      await store().advance(a, runId, {
        cursor: patientId('pat-0001'),
        delta: {
          patientsScanned: 1,
          patientsRepaired: 1,
          patientsSkipped: 0,
          repairs: 3,
          repairsByKind: { expectation_created: 2, case_opened: 1 },
        },
        now: at(1),
      });
      const advanced = await store().advance(a, runId, {
        cursor: patientId('pat-0002'),
        delta: {
          patientsScanned: 1,
          patientsRepaired: 1,
          patientsSkipped: 1,
          repairs: 2,
          repairsByKind: { expectation_created: 1, case_resolved: 1 },
        },
        now: at(2),
      });
      expect(advanced).toMatchObject({
        cursor: 'pat-0002',
        patientsScanned: 2,
        patientsRepaired: 2,
        patientsSkipped: 1,
        repairs: 5,
        repairsByKind: { expectation_created: 3, case_opened: 1, case_resolved: 1 },
        updatedAt: at(2),
      });
      expect(await store().get(a, runId)).toEqual(advanced);
    });

    it('finishes once; a finished run neither advances nor finishes again', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { scope: 'all', now: at(0) });
      const done = await store().finish(a, runId, { status: 'completed', now: at(1) });
      expect(done).toMatchObject({ status: 'completed', finishedAt: at(1) });
      await expectRejectsWithName(
        store().advance(a, runId, {
          cursor: patientId('p'),
          delta: ZERO_RECONCILIATION_COUNTS,
          now: at(2),
        }),
        'NotFoundError',
      );
      await expectRejectsWithName(
        store().finish(a, runId, { status: 'failed', error: 'x', now: at(2) }),
        'NotFoundError',
      );
      expect(await store().lastCompleted(a)).toEqual(done);
    });

    it('lists runs most recent first; the last completed one is the latest completed', async () => {
      const { a } = freshClinics();
      const first = uniqueId('run');
      const second = uniqueId('run');
      const third = uniqueId('run');
      await store().start(a, first, { scope: 'all', watermark: '10', now: at(0) });
      await store().finish(a, first, { status: 'completed', now: at(0) });
      await store().start(a, second, { scope: 'recent', watermark: '20', now: at(1) });
      await store().finish(a, second, { status: 'completed', now: at(1) });
      await store().start(a, third, { scope: 'recent', now: at(2) });
      await store().finish(a, third, { status: 'failed', error: 'boom', now: at(2) });
      expect((await store().list(a, { limit: 10 })).map((run) => run.runId)).toEqual([
        third,
        second,
        first,
      ]);
      expect((await store().list(a, { limit: 1 })).map((run) => run.runId)).toEqual([third]);
      expect((await store().lastCompleted(a))?.watermark).toBe('20');
      expect((await store().get(a, third))?.lastError).toBe('boom');
    });

    it('appends repairs and lists them in order, by run and by patient', async () => {
      const { a } = freshClinics();
      const runId = uniqueId('run');
      const other = uniqueId('run');
      // No rule, status before or detail: optional fields come back absent.
      const caseRepair: ReconciliationRepair = {
        clinicId: a,
        runId,
        patientId: patientId('pat-0002'),
        kind: 'case_opened',
        entityId: uniqueId('case'),
        to: 'open',
        actor: RECONCILIATION_ACTOR,
        reason: 'reconciliation',
        at: at(2),
      };
      const repairs: ReconciliationRepair[] = [
        aRepair(a, runId),
        caseRepair,
        aRepair(a, other, { kind: 'expectation_created' }),
      ];
      await store().recordRepairs(a, repairs);
      expect(await store().listRepairs(a, { limit: 10 })).toEqual(repairs);
      expect(await store().listRepairs(a, { runId, limit: 10 })).toEqual(repairs.slice(0, 2));
      expect(await store().listRepairs(a, { patientId: patientId('pat-0002'), limit: 10 })).toEqual(
        [repairs[1]],
      );
      expect(await store().listRepairs(a, { limit: 1 })).toEqual([repairs[0]]);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const runId = uniqueId('run');
      await store().start(a, runId, { scope: 'all', now: at(0) });
      await store().recordRepairs(a, [aRepair(a, runId)]);
      expect(await store().get(b, runId)).toBeUndefined();
      expect(await store().findRunning(b)).toBeUndefined();
      expect(await store().list(b, { limit: 10 })).toEqual([]);
      expect(await store().listRepairs(b, { limit: 10 })).toEqual([]);
      await expectRejectsWithName(
        store().finish(b, runId, { status: 'completed', now: at(1) }),
        'NotFoundError',
      );
      // The same run id is independent per clinic, and B may run concurrently.
      await store().start(b, runId, { scope: 'all', now: at(0) });
      expect((await store().findRunning(a))?.clinicId).toBe(a);
    });
  });
}
