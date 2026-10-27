import { FakeClock, type ClaimedJob, type JobId } from '@follow-up-engine/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapters, type PostgresAdapters } from './adapters.ts';
import { DEFAULT_JOB_BACKOFF } from './job-queue.ts';
import { at, BASE, newClinic } from './test-fixtures.ts';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  testDatabaseUrl,
  type IsolatedDatabase,
} from './testing.ts';

const LEASE = { minutes: 5 } as const;

describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle('PostgresJobQueue'), () => {
  let db: IsolatedDatabase;
  let pg1: PostgresAdapters;
  const clock = new FakeClock(BASE);

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    pg1 = db.adapters({ clock });
  });

  afterAll(async () => {
    await db.dispose();
  });

  /** Jobs are claimed across clinics, so each test uses its own job type to stay independent. */
  function jobType(name: string): string {
    return `test.${name}.${Math.random().toString(36).slice(2, 8)}`;
  }

  async function claimOne(type: string, now: Date, workerId = 'w1'): Promise<ClaimedJob> {
    const [job] = await pg1.jobs.claim({ workerId, types: [type], limit: 1, leaseFor: LEASE, now });
    if (job === undefined) {
      throw new Error('expected a job to claim');
    }
    return job;
  }

  it('enqueues at the clock’s now by default and claims runnable jobs in run_at order', async () => {
    const clinic = newClinic();
    const type = jobType('order');
    const later = await pg1.jobs.enqueue(clinic, { type, payload: { n: 2 }, runAt: at(0, 2) });
    const now = await pg1.jobs.enqueue(clinic, { type, payload: { n: 1 } });
    const future = await pg1.jobs.enqueue(clinic, { type, payload: { n: 3 }, runAt: at(1) });

    const claimed = await pg1.jobs.claim({
      workerId: 'w1',
      types: [type],
      limit: 10,
      leaseFor: LEASE,
      now: at(0, 3),
    });
    expect(claimed.map((job) => job.id)).toEqual([now, later]);
    expect(claimed[0]).toMatchObject({
      clinicId: clinic,
      type,
      payload: { n: 1 },
      attempt: 1,
      maxAttempts: 5,
      leaseExpiresAt: new Date(at(0, 3).getTime() + 5 * 60_000),
    });
    expect((await pg1.jobs.inspect(clinic, future))?.status).toBe('pending');
  });

  it('filters by type and claims across clinics, each job carrying its clinic', async () => {
    const [a, b] = [newClinic(), newClinic()];
    const type = jobType('cross');
    const other = jobType('other');
    await pg1.jobs.enqueue(a, { type, payload: {} });
    await pg1.jobs.enqueue(b, { type, payload: {} });
    await pg1.jobs.enqueue(a, { type: other, payload: {} });
    const claimed = await pg1.jobs.claim({
      workerId: 'w',
      types: [type],
      limit: 10,
      leaseFor: LEASE,
      now: at(1),
    });
    expect(claimed.map((job) => job.clinicId).sort()).toEqual([a, b].sort());
  });

  it('deduplicates unfinished jobs by type and key, per clinic', async () => {
    const [a, b] = [newClinic(), newClinic()];
    const type = jobType('dedup');
    const first = await pg1.jobs.enqueue(a, { type, payload: { v: 1 }, dedupKey: 'doc-1' });
    expect(await pg1.jobs.enqueue(a, { type, payload: { v: 2 }, dedupKey: 'doc-1' })).toBe(first);
    expect(await pg1.jobs.enqueue(b, { type, payload: {}, dedupKey: 'doc-1' })).not.toBe(first);
    expect(
      await pg1.jobs.enqueue(a, { type: jobType('x'), payload: {}, dedupKey: 'doc-1' }),
    ).not.toBe(first);

    // Still deduplicated while running; free again once finished.
    const claimed = await pg1.jobs.claim({
      workerId: 'w',
      types: [type],
      limit: 10,
      leaseFor: LEASE,
      now: at(1),
    });
    const job = claimed.find((each) => each.clinicId === a);
    if (job === undefined) {
      throw new Error('expected the job of clinic a');
    }
    expect(job.id).toBe(first);
    expect(await pg1.jobs.enqueue(a, { type, payload: {}, dedupKey: 'doc-1' })).toBe(first);
    expect(await pg1.jobs.complete(a, job)).toBe('acknowledged');
    const again = await pg1.jobs.enqueue(a, { type, payload: {}, dedupKey: 'doc-1' });
    expect(again).not.toBe(first);
  });

  it('completes a job only for the holder of its lease and clinic', async () => {
    const [a, b] = [newClinic(), newClinic()];
    const type = jobType('complete');
    const id = await pg1.jobs.enqueue(a, { type, payload: {} });
    const job = await claimOne(type, at(1));
    expect(await pg1.jobs.complete(b, job)).toBe('lease_lost');
    expect(
      await pg1.jobs.complete(a, { id, leaseToken: '00000000-0000-4000-8000-000000000000' }),
    ).toBe('lease_lost');
    expect(await pg1.jobs.complete(a, { id, leaseToken: 'not-a-uuid' })).toBe('lease_lost');
    expect(await pg1.jobs.complete(a, job)).toBe('acknowledged');
    expect(await pg1.jobs.complete(a, job)).toBe('lease_lost');
    expect((await pg1.jobs.inspect(a, id))?.status).toBe('completed');
    expect(
      await pg1.jobs.claim({ workerId: 'w', types: [type], limit: 1, leaseFor: LEASE, now: at(9) }),
    ).toEqual([]);
  });

  it('reclaims a job whose lease expired; the stale holder gets lease_lost', async () => {
    const clinic = newClinic();
    const type = jobType('lease');
    await pg1.jobs.enqueue(clinic, { type, payload: {} });
    const stale = await claimOne(type, at(1), 'crashed-worker');

    // Within the lease nobody else can take it.
    expect(
      await pg1.jobs.claim({
        workerId: 'w2',
        types: [type],
        limit: 1,
        leaseFor: LEASE,
        now: at(1, 0.05),
      }),
    ).toEqual([]);

    const fresh = await claimOne(type, new Date(stale.leaseExpiresAt.getTime() + 1), 'w2');
    expect(fresh.id).toBe(stale.id);
    expect(fresh.attempt).toBe(2);
    expect(fresh.leaseToken).not.toBe(stale.leaseToken);

    expect(await pg1.jobs.complete(clinic, stale)).toBe('lease_lost');
    expect(await pg1.jobs.fail(clinic, stale, { error: 'late' })).toBe('lease_lost');
    expect(await pg1.jobs.complete(clinic, fresh)).toBe('acknowledged');
  });

  it('accepts an ack after lease expiry when nobody reclaimed the job', async () => {
    const clinic = newClinic();
    const type = jobType('late-ack');
    await pg1.jobs.enqueue(clinic, { type, payload: {} });
    const job = await claimOne(type, at(1));
    clock.set(at(30));
    expect(await pg1.jobs.complete(clinic, job)).toBe('acknowledged');
    clock.set(BASE);
  });

  it('retries failures with backoff or at retryAt, then dead-letters after maxAttempts', async () => {
    const clinic = newClinic();
    const type = jobType('retry');
    const id = await pg1.jobs.enqueue(clinic, { type, payload: {}, maxAttempts: 3 });

    clock.set(at(1));
    const first = await claimOne(type, at(1));
    expect(await pg1.jobs.fail(clinic, first, { error: 'provider timeout' })).toBe('acknowledged');
    let snapshot = await pg1.jobs.inspect(clinic, id);
    expect(snapshot).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'provider timeout',
    });
    expect(snapshot?.runAt).toEqual(new Date(at(1).getTime() + DEFAULT_JOB_BACKOFF.baseMs));

    // Not runnable before its retry time.
    expect(
      await pg1.jobs.claim({ workerId: 'w', types: [type], limit: 1, leaseFor: LEASE, now: at(1) }),
    ).toEqual([]);
    const second = await claimOne(type, at(2));
    expect(second.attempt).toBe(2);
    expect(await pg1.jobs.fail(clinic, second, { error: 'again', retryAt: at(3) })).toBe(
      'acknowledged',
    );
    expect((await pg1.jobs.inspect(clinic, id))?.runAt).toEqual(at(3));

    const third = await claimOne(type, at(3));
    expect(third.attempt).toBe(3);
    expect(await pg1.jobs.fail(clinic, third, { error: 'final' })).toBe('acknowledged');
    snapshot = await pg1.jobs.inspect(clinic, id);
    expect(snapshot).toMatchObject({ status: 'dead', attempts: 3, lastError: 'final' });
    expect(
      await pg1.jobs.claim({
        workerId: 'w',
        types: [type],
        limit: 1,
        leaseFor: LEASE,
        now: at(99),
      }),
    ).toEqual([]);
    clock.set(BASE);
  });

  it('dead-letters a job whose final lease expired instead of running it again', async () => {
    const clinic = newClinic();
    const type = jobType('final-lease');
    const id = await pg1.jobs.enqueue(clinic, { type, payload: {}, maxAttempts: 1 });
    const job = await claimOne(type, at(1));
    expect(
      await pg1.jobs.claim({
        workerId: 'w2',
        types: [type],
        limit: 1,
        leaseFor: LEASE,
        now: at(2),
      }),
    ).toEqual([]);
    expect(await pg1.jobs.inspect(clinic, id)).toMatchObject({
      status: 'dead',
      lastError: 'lease expired on the final attempt',
    });
    expect(await pg1.jobs.complete(clinic, job)).toBe('lease_lost');
  });

  it('enqueues inside a unit of work only if it commits', async () => {
    const clinic = newClinic();
    const type = jobType('uow');
    const enqueued: JobId[] = [];
    await expect(
      pg1.unitOfWork.withTransaction(clinic, async (stores) => {
        enqueued.push(await stores.jobs.enqueue(clinic, { type, payload: {} }));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(enqueued).toHaveLength(1);
    for (const id of enqueued) {
      expect(await pg1.jobs.inspect(clinic, id)).toBeUndefined();
    }
  });

  it('never gives the same job to two workers on separate connections', async () => {
    const clinic = newClinic();
    const type = jobType('concurrent');
    const total = 200;
    await pg1.unitOfWork.withTransaction(clinic, async (stores) => {
      for (let index = 0; index < total; index += 1) {
        await stores.jobs.enqueue(clinic, { type, payload: { index } });
      }
    });

    // Two independent pools: two processes as far as Postgres is concerned.
    const pools = [0, 1].map(() => new pg.Pool({ connectionString: testDatabaseUrl(), max: 4 }));
    try {
      const workers = pools.map((pool) =>
        createPostgresAdapters(pool, { schema: db.schema, clock }),
      );
      const claimedBy = new Map<string, string>();
      const duplicates: string[] = [];
      const run = async (worker: PostgresAdapters, name: string) => {
        for (;;) {
          const batch = await worker.jobs.claim({
            workerId: name,
            types: [type],
            limit: 7,
            leaseFor: LEASE,
            now: at(1),
          });
          if (batch.length === 0) {
            return;
          }
          for (const job of batch) {
            if (claimedBy.has(job.id)) {
              duplicates.push(job.id);
            }
            claimedBy.set(job.id, name);
            expect(await worker.jobs.complete(clinic, job)).toBe('acknowledged');
          }
        }
      };
      // Several concurrent claim loops per pool.
      await Promise.all(
        workers.flatMap((worker, index) =>
          [0, 1, 2].map((loop) => run(worker, `worker-${String(index)}-${String(loop)}`)),
        ),
      );
      expect(duplicates).toEqual([]);
      expect(claimedBy.size).toBe(total);
      const perPool = [0, 1].map(
        (index) =>
          [...claimedBy.values()].filter((name) => name.startsWith(`worker-${String(index)}`))
            .length,
      );
      expect(perPool.every((count) => count > 0)).toBe(true);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});
