import type { UnitOfWork } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  aCase,
  aCaseEvent,
  aCondition,
  aDomainEvent,
  aFeedback,
  anExpectation,
  aQualityFinding,
} from './builders.ts';
import { at, freshClinics, uniqueId, useSubject } from './harness.ts';
import type { OutboxContractSubject } from './job-queue.contract.ts';

/** What the UnitOfWork contract needs: the port and, optionally, the outbox reader. */
export interface UnitOfWorkContractSubject {
  readonly subject: UnitOfWork;
  /** When given, the suite also checks that outbox events roll back. */
  readonly pendingOutbox?: OutboxContractSubject['pending'];
  readonly cleanup: () => Promise<void>;
}

class Boom extends Error {
  override readonly name = 'Boom';
}

/**
 * Contract every {@link UnitOfWork} adapter must pass: work either commits
 * as a whole or leaves no trace, across every store including jobs and the
 * outbox.
 */
export function describeUnitOfWorkContract(
  name: string,
  makeSubject: () => Promise<UnitOfWorkContractSubject>,
): void {
  describe(`UnitOfWork contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const uow = () => current().subject;

    function writes(clinic: ReturnType<typeof freshClinics>['a'], jobType: string) {
      const expectation = anExpectation(clinic);
      const followUp = aCase(clinic);
      const event = aDomainEvent(clinic);
      return {
        expectation,
        followUp,
        event,
        apply: async (stores: Parameters<Parameters<UnitOfWork['withTransaction']>[1]>[0]) => {
          await stores.expectations.upsertByIdempotencyKey(clinic, expectation);
          await stores.cases.create(clinic, followUp);
          await stores.audit.append(clinic, aCaseEvent(clinic, { caseId: followUp.id }));
          await stores.feedback.record(clinic, aFeedback(clinic, { caseId: followUp.id }));
          await stores.conditions.upsert(
            clinic,
            aCondition(clinic, { patientId: followUp.patientId }),
          );
          await stores.qualityFindings.save(
            clinic,
            aQualityFinding(clinic, { patientId: followUp.patientId }),
          );
          await stores.jobs.enqueue(clinic, {
            type: jobType,
            payload: { caseId: followUp.id },
            runAt: at(0),
          });
          await stores.outbox.add(clinic, event);
        },
      };
    }

    it('commits every write together and returns the work result', async () => {
      const { a } = freshClinics();
      const jobType = uniqueId('contract.uow');
      const w = writes(a, jobType);
      const result = await uow().withTransaction(a, async (stores) => {
        await w.apply(stores);
        return 42;
      });
      expect(result).toBe(42);

      await uow().withTransaction(a, async (stores) => {
        expect(await stores.expectations.get(a, w.expectation.id)).toEqual(w.expectation);
        expect(await stores.cases.get(a, w.followUp.id)).toEqual(w.followUp);
        expect(await stores.audit.listForCase(a, w.followUp.id)).toHaveLength(1);
        expect(await stores.feedback.listForCase(a, w.followUp.id)).toHaveLength(1);
        expect(await stores.conditions.listByPatient(a, w.followUp.patientId)).toHaveLength(1);
        expect(await stores.qualityFindings.listByPatient(a, w.followUp.patientId)).toHaveLength(1);
        const jobs = await stores.jobs.claim({
          workerId: 'w',
          types: [jobType],
          limit: 5,
          leaseFor: { minutes: 1 },
          now: at(0),
        });
        expect(jobs).toHaveLength(1);
      });
      const pending = current().pendingOutbox;
      if (pending) expect((await pending(a)).map((e) => e.id)).toContain(w.event.id);
    });

    it('rolls back every write when the work throws, and rethrows', async () => {
      const { a } = freshClinics();
      const jobType = uniqueId('contract.uow');
      const w = writes(a, jobType);
      await expect(
        uow().withTransaction(a, async (stores) => {
          await w.apply(stores);
          throw new Boom('fail after writing');
        }),
      ).rejects.toMatchObject({ name: 'Boom' });

      await uow().withTransaction(a, async (stores) => {
        expect(await stores.expectations.get(a, w.expectation.id)).toBeUndefined();
        expect(await stores.cases.get(a, w.followUp.id)).toBeUndefined();
        expect(await stores.cases.findActiveByDedupKey(a, w.followUp.dedupKey)).toBeUndefined();
        expect(await stores.audit.listForCase(a, w.followUp.id)).toEqual([]);
        expect(await stores.feedback.listForCase(a, w.followUp.id)).toEqual([]);
        expect(await stores.conditions.listByPatient(a, w.followUp.patientId)).toEqual([]);
        expect(await stores.qualityFindings.listByPatient(a, w.followUp.patientId)).toEqual([]);
        const jobs = await stores.jobs.claim({
          workerId: 'w',
          types: [jobType],
          limit: 5,
          leaseFor: { minutes: 1 },
          now: at(10),
        });
        expect(jobs).toEqual([]);
      });
      const pending = current().pendingOutbox;
      if (pending) expect((await pending(a)).map((e) => e.id)).not.toContain(w.event.id);
    });

    it('rolls back a failing transaction without touching an earlier committed one', async () => {
      const { a } = freshClinics();
      const kept = anExpectation(a);
      await uow().withTransaction(a, (stores) =>
        stores.expectations.upsertByIdempotencyKey(a, kept),
      );
      const updated = { ...kept, status: 'fulfilled' as const, updatedAt: at(1) };
      await expect(
        uow().withTransaction(a, async (stores) => {
          await stores.expectations.update(a, updated);
          throw new Boom('undo the update');
        }),
      ).rejects.toMatchObject({ name: 'Boom' });
      await uow().withTransaction(a, async (stores) => {
        expect(await stores.expectations.get(a, kept.id)).toEqual(kept);
      });
    });

    it('isolates clinics inside a transaction', async () => {
      const { a, b } = freshClinics();
      const e = anExpectation(a);
      await uow().withTransaction(a, (stores) => stores.expectations.upsertByIdempotencyKey(a, e));
      await uow().withTransaction(b, async (stores) => {
        expect(await stores.expectations.get(b, e.id)).toBeUndefined();
        expect(await stores.expectations.findDue(b, at(1000), 100)).toEqual([]);
      });
    });
  });
}
