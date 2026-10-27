import type { ClaimOptions, ClinicId, DomainEvent, JobQueue, Outbox } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aDomainEvent } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

/**
 * Contract every {@link JobQueue} adapter must pass. Each test uses its own
 * job type and filters `claim` by it, so the suite is safe on a shared database.
 */
export function describeJobQueueContract(name: string, makeSubject: MakeSubject<JobQueue>): void {
  describe(`JobQueue contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const queue = () => current().subject;

    function claimOptions(
      type: string,
      now: Date,
      overrides: Partial<ClaimOptions> = {},
    ): ClaimOptions {
      return {
        workerId: 'worker-1',
        types: [type],
        limit: 10,
        leaseFor: { minutes: 5 },
        now,
        ...overrides,
      };
    }

    it('enqueues and claims a job with its clinic, payload and first attempt', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      const id = await queue().enqueue(a, {
        type,
        payload: { patientId: 'pat-1', n: 1 },
        runAt: at(0),
      });
      const [job, ...rest] = await queue().claim(claimOptions(type, at(0)));
      expect(rest).toEqual([]);
      expect(job).toMatchObject({
        id,
        clinicId: a,
        type,
        payload: { patientId: 'pat-1', n: 1 },
        attempt: 1,
        maxAttempts: 5,
      });
      expect(job?.leaseExpiresAt).toEqual(new Date(at(0).getTime() + 5 * 60_000));
    });

    it('does not hand out a job before runAt, nor a leased job twice', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: {}, runAt: at(1) });
      expect(await queue().claim(claimOptions(type, at(0.5)))).toEqual([]);
      expect(await queue().claim(claimOptions(type, at(1)))).toHaveLength(1);
      expect(await queue().claim(claimOptions(type, at(1), { workerId: 'worker-2' }))).toEqual([]);
    });

    it('claims by runAt ascending, honours the limit and the type filter', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      const later = await queue().enqueue(a, { type, payload: { order: 2 }, runAt: at(0.2) });
      const sooner = await queue().enqueue(a, { type, payload: { order: 1 }, runAt: at(0.1) });
      await queue().enqueue(a, { type: uniqueId('contract.other'), payload: {}, runAt: at(0) });
      const first = await queue().claim(claimOptions(type, at(1), { limit: 1 }));
      expect(first.map((j) => j.id)).toEqual([sooner]);
      const second = await queue().claim(claimOptions(type, at(1)));
      expect(second.map((j) => j.id)).toEqual([later]);
    });

    it('acknowledges completion by the lease holder and never runs the job again', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: {}, runAt: at(0) });
      const [job] = await queue().claim(claimOptions(type, at(0)));
      if (!job) throw new Error('no job claimed');
      expect(await queue().complete(a, job)).toBe('acknowledged');
      expect(await queue().claim(claimOptions(type, at(10)))).toEqual([]);
    });

    it('reclaims a job whose lease expired; the stale holder gets lease_lost', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: {}, runAt: at(0) });
      const [stale] = await queue().claim(claimOptions(type, at(0)));
      if (!stale) throw new Error('no job claimed');
      expect(await queue().claim(claimOptions(type, at(4 / 1440)))).toEqual([]);

      const [fresh] = await queue().claim(
        claimOptions(type, at(6 / 1440), { workerId: 'worker-2' }),
      );
      if (!fresh) throw new Error('expired lease was not reclaimed');
      expect(fresh.id).toBe(stale.id);
      expect(fresh.attempt).toBe(2);
      expect(fresh.leaseToken).not.toBe(stale.leaseToken);

      expect(await queue().complete(a, stale)).toBe('lease_lost');
      expect(await queue().fail(a, stale, { error: 'late' })).toBe('lease_lost');
      expect(await queue().complete(a, fresh)).toBe('acknowledged');
    });

    it('retries a failed job at retryAt and dead-letters it after maxAttempts', async () => {
      const { a } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: {}, runAt: at(0), maxAttempts: 2 });
      const [first] = await queue().claim(claimOptions(type, at(0)));
      if (!first) throw new Error('no job claimed');
      expect(await queue().fail(a, first, { error: 'boom', retryAt: at(1) })).toBe('acknowledged');
      expect(await queue().claim(claimOptions(type, at(0.5)))).toEqual([]);

      const [second] = await queue().claim(claimOptions(type, at(1)));
      expect(second?.attempt).toBe(2);
      if (!second) throw new Error('job was not retried');
      expect(await queue().fail(a, second, { error: 'boom again', retryAt: at(2) })).toBe(
        'acknowledged',
      );
      expect(await queue().claim(claimOptions(type, at(30)))).toEqual([]);
    });

    it('deduplicates on type + dedupKey within a clinic only', async () => {
      const { a, b } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: { n: 1 }, runAt: at(0), dedupKey: 'pat-1' });
      await queue().enqueue(a, { type, payload: { n: 2 }, runAt: at(0), dedupKey: 'pat-1' });
      await queue().enqueue(b, { type, payload: { n: 3 }, runAt: at(0), dedupKey: 'pat-1' });
      const claimed = await queue().claim(claimOptions(type, at(0)));
      expect(claimed.map((j) => j.clinicId).sort()).toEqual([a, b].sort());
    });

    it('isolates clinics: a lease cannot be completed from another clinic', async () => {
      const { a, b } = freshClinics();
      const type = uniqueId('contract.job');
      await queue().enqueue(a, { type, payload: {}, runAt: at(0) });
      const [job] = await queue().claim(claimOptions(type, at(0)));
      if (!job) throw new Error('no job claimed');
      const outcome = await queue()
        .complete(b, job)
        .catch(() => 'rejected' as const);
      expect(outcome).not.toBe('acknowledged');
      expect(await queue().complete(a, job)).toBe('acknowledged');
    });
  });
}

/**
 * What the Outbox contract needs: the port, plus a way to read what is
 * pending delivery for a clinic (the worker's side of the outbox).
 */
export interface OutboxContractSubject {
  readonly subject: Outbox;
  readonly pending: (clinicId: ClinicId) => Promise<readonly DomainEvent[]>;
  readonly cleanup: () => Promise<void>;
}

/** Contract every {@link Outbox} adapter must pass. */
export function describeOutboxContract(
  name: string,
  makeSubject: () => Promise<OutboxContractSubject>,
): void {
  describe(`Outbox contract: ${name}`, () => {
    const current = useSubject(makeSubject);

    it('keeps added events pending delivery, intact', async () => {
      const { a } = freshClinics();
      const opened = aDomainEvent(a);
      const contact = aDomainEvent(a, {
        type: 'patient_contact.requested',
        payload: {
          caseId: 'case-1',
          patientId: 'pat-1',
          purpose: 'schedule_follow_up',
          dueBy: at(10),
        },
      } as Partial<DomainEvent>);
      await current().subject.add(a, opened);
      await current().subject.add(a, contact);
      const pending = await current().pending(a);
      expect(new Set(pending.map((e) => e.id))).toEqual(new Set([opened.id, contact.id]));
      expect(pending.find((e) => e.id === contact.id)).toEqual(contact);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      await current().subject.add(a, aDomainEvent(a));
      expect(await current().pending(b)).toEqual([]);
      await expectRejectsWithName(current().subject.add(a, aDomainEvent(b)), 'TenantMismatchError');
    });
  });
}
