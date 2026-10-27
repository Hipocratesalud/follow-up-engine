import {
  FakeClock,
  TenantMismatchError,
  type ClinicId,
  type DomainEvent,
  type EventPublisher,
} from '@follow-up-engine/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresAdapters, type PostgresAdapters } from './adapters.ts';
import { DEFAULT_OUTBOX_BACKOFF } from './outbox.ts';
import { at, BASE, newClinic } from './test-fixtures.ts';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  testDatabaseUrl,
  type IsolatedDatabase,
} from './testing.ts';

const LEASE = { minutes: 1 } as const;

class RecordingPublisher implements EventPublisher {
  readonly published: { clinicId: ClinicId; event: DomainEvent }[] = [];
  failWith: string | undefined;

  publish(clinicId: ClinicId, event: DomainEvent): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(new Error(this.failWith));
    }
    this.published.push({ clinicId, event });
    return Promise.resolve();
  }
}

function contactRequested(clinicId: ClinicId, id: string): DomainEvent {
  return {
    id,
    type: 'patient_contact.requested',
    clinicId,
    occurredAt: at(1),
    payload: {
      caseId: 'case-1' as never,
      patientId: 'pat-1' as never,
      purpose: 'schedule_follow_up',
      dueBy: at(10),
    },
  };
}

function caseResolved(clinicId: ClinicId, id: string): DomainEvent {
  return {
    id,
    type: 'case.resolved',
    clinicId,
    occurredAt: at(2),
    payload: { caseId: 'case-1' as never, patientId: 'pat-1' as never, resolution: 'fulfilled' },
  };
}

describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle('Postgres outbox'), () => {
  let db: IsolatedDatabase;
  let adapters: PostgresAdapters;

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    adapters = db.adapters({ clock: new FakeClock(BASE) });
  });

  beforeEach(async () => {
    // The relay drains every clinic, so each test starts from an empty outbox.
    await db.pool.query(`TRUNCATE "${db.schema}".outbox`);
  });

  afterAll(async () => {
    await db.dispose();
  });

  it('delivers events in insertion order with their dates revived, exactly once per pass', async () => {
    const [a, b] = [newClinic(), newClinic()];
    const events = [contactRequested(a, 'e1'), caseResolved(b, 'e2'), caseResolved(a, 'e3')];
    for (const event of events) {
      await adapters.outbox.add(event.clinicId, event);
    }
    await adapters.outbox.add(a, contactRequested(a, 'e1')); // idempotent on id

    const publisher = new RecordingPublisher();
    expect(
      await adapters.drainOutbox({ publisher, now: at(1), limit: 10, leaseFor: LEASE }),
    ).toEqual({
      delivered: 3,
      retrying: 0,
      dead: 0,
    });
    expect(publisher.published).toEqual(
      events.map((event) => ({ clinicId: event.clinicId, event })),
    );
    expect(
      await adapters.drainOutbox({ publisher, now: at(2), limit: 10, leaseFor: LEASE }),
    ).toEqual({
      delivered: 0,
      retrying: 0,
      dead: 0,
    });
  });

  it('rejects an event of another clinic', async () => {
    const [a, b] = [newClinic(), newClinic()];
    await expect(adapters.outbox.add(b, caseResolved(a, 'x'))).rejects.toThrow(TenantMismatchError);
  });

  it('retries failed deliveries with backoff and dead-letters after maxAttempts', async () => {
    const clinic = newClinic();
    await adapters.outbox.add(clinic, caseResolved(clinic, 'e1'));
    const publisher = new RecordingPublisher();
    publisher.failWith = 'host returned 503';
    const drain = (now: Date) =>
      adapters.drainOutbox({ publisher, now, limit: 10, leaseFor: LEASE, maxAttempts: 2 });

    expect(await drain(at(1))).toEqual({ delivered: 0, retrying: 1, dead: 0 });
    // Not due again before the backoff elapses.
    expect(await drain(new Date(at(1).getTime() + DEFAULT_OUTBOX_BACKOFF.baseMs - 1))).toEqual({
      delivered: 0,
      retrying: 0,
      dead: 0,
    });
    expect(await drain(new Date(at(1).getTime() + DEFAULT_OUTBOX_BACKOFF.baseMs))).toEqual({
      delivered: 0,
      retrying: 0,
      dead: 1,
    });
    publisher.failWith = undefined;
    expect(await drain(at(30))).toEqual({ delivered: 0, retrying: 0, dead: 0 });
    const { rows } = await db.pool.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM "${db.schema}".outbox WHERE clinic_id = $1`,
      [clinic],
    );
    expect(rows).toEqual([{ status: 'dead', last_error: 'host returned 503' }]);
  });

  it('recovers a delivered-but-unacknowledged batch after its lease expires', async () => {
    const clinic = newClinic();
    await adapters.outbox.add(clinic, caseResolved(clinic, 'e1'));
    // A relay claims and dies before acknowledging: simulate with a claim-only statement.
    await db.pool.query(
      `UPDATE "${db.schema}".outbox SET lease_token = gen_random_uuid(),
         lease_expires_at = $1, attempts = attempts + 1 WHERE clinic_id = $2`,
      [new Date(at(1).getTime() + 60_000), clinic],
    );
    const publisher = new RecordingPublisher();
    expect(
      await adapters.drainOutbox({ publisher, now: at(1), limit: 10, leaseFor: LEASE }),
    ).toMatchObject({ delivered: 0 });
    expect(
      await adapters.drainOutbox({
        publisher,
        now: new Date(at(1).getTime() + 60_000),
        limit: 10,
        leaseFor: LEASE,
      }),
    ).toMatchObject({ delivered: 1 });
  });

  it('commits outbox events only with their unit of work', async () => {
    const clinic = newClinic();
    await expect(
      adapters.unitOfWork.withTransaction(clinic, async (stores) => {
        await stores.outbox.add(clinic, caseResolved(clinic, 'rolled-back'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await adapters.unitOfWork.withTransaction(clinic, (stores) =>
      stores.outbox.add(clinic, caseResolved(clinic, 'committed')),
    );
    const publisher = new RecordingPublisher();
    await adapters.drainOutbox({ publisher, now: at(5), limit: 10, leaseFor: LEASE });
    expect(publisher.published.map(({ event }) => event.id)).toEqual(['committed']);
  });

  it('never delivers one event from two concurrent relays', async () => {
    const clinic = newClinic();
    const total = 120;
    await adapters.unitOfWork.withTransaction(clinic, async (stores) => {
      for (let index = 0; index < total; index += 1) {
        await stores.outbox.add(clinic, caseResolved(clinic, `e-${String(index)}`));
      }
    });
    const pools = [0, 1].map(() => new pg.Pool({ connectionString: testDatabaseUrl(), max: 3 }));
    try {
      const relays = pools.map((pool) => createPostgresAdapters(pool, { schema: db.schema }));
      const publisher = new RecordingPublisher();
      const loop = async (relay: PostgresAdapters) => {
        for (;;) {
          const { delivered } = await relay.drainOutbox({
            publisher,
            now: at(5),
            limit: 5,
            leaseFor: LEASE,
          });
          if (delivered === 0) {
            return;
          }
        }
      };
      await Promise.all(relays.flatMap((relay) => [loop(relay), loop(relay)]));
      const ids = publisher.published.map(({ event }) => event.id);
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});
