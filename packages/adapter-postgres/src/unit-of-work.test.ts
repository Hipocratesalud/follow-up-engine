import {
  expectationId,
  FakeClock,
  TenantMismatchError,
  type DomainEvent,
} from '@follow-up-engine/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgresAdapters } from './adapters.ts';
import { at, BASE, makeCase, makeExpectation, newClinic } from './test-fixtures.ts';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  testDatabaseUrl,
  type IsolatedDatabase,
} from './testing.ts';
import { TransactionAbortedError, TransactionClosedError } from './unit-of-work.ts';

class Boom extends Error {}

describe.skipIf(testDatabaseUrl() === undefined)(databaseSuiteTitle('PostgresUnitOfWork'), () => {
  let db: IsolatedDatabase;
  let pg: PostgresAdapters;

  beforeAll(async () => {
    db = await createIsolatedDatabase();
    pg = db.adapters({ clock: new FakeClock(BASE) });
  });

  afterAll(async () => {
    await db.dispose();
  });

  function caseOpened(clinicId: ReturnType<typeof newClinic>, id: string): DomainEvent {
    return {
      id,
      type: 'case.opened',
      clinicId,
      occurredAt: at(1),
      payload: {
        caseId: 'case-1' as never,
        patientId: 'pat-1' as never,
        reasons: [],
        priority: 1,
        origin: 'live',
      },
    };
  }

  async function count(table: string, clinicId: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${db.schema}"."${table}" WHERE clinic_id = $1`,
      [clinicId],
    );
    return rows[0]?.n ?? 0;
  }

  it('runs concurrent store calls inside a transaction one at a time, without pg warnings', async () => {
    const clinicId = newClinic();
    const expectations = Array.from({ length: 12 }, (_, index) =>
      makeExpectation(clinicId, { id: expectationId(`exp-concurrent-${String(index)}`) }),
    );
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.message);
    };
    process.on('warning', onWarning);
    try {
      const read = await pg.unitOfWork.withTransaction(clinicId, async (stores) => {
        await Promise.all(
          expectations.map((expectation) =>
            stores.expectations.upsertByIdempotencyKey(clinicId, expectation),
          ),
        );
        return Promise.all(
          expectations.map((expectation) => stores.expectations.get(clinicId, expectation.id)),
        );
      });
      expect(read.map((expectation) => expectation?.id)).toEqual(
        expectations.map((expectation) => expectation.id),
      );
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.filter((message) => message.includes('already executing a query'))).toEqual([]);
  });

  it('commits every store write together', async () => {
    const clinic = newClinic();
    const expectation = makeExpectation(clinic);
    const result = await pg.unitOfWork.withTransaction(clinic, async (stores) => {
      await stores.expectations.upsertByIdempotencyKey(clinic, expectation);
      await stores.cases.create(clinic, makeCase(clinic));
      await stores.jobs.enqueue(clinic, {
        type: 'note.extract_plan',
        payload: { documentId: 'd1' },
      });
      await stores.outbox.add(clinic, caseOpened(clinic, 'evt-1'));
      return 'done';
    });
    expect(result).toBe('done');
    expect(await pg.expectations.get(clinic, expectation.id)).toEqual(expectation);
    expect(await count('follow_up_cases', clinic)).toBe(1);
    expect(await count('jobs', clinic)).toBe(1);
    expect(await count('outbox', clinic)).toBe(1);
  });

  it('rolls back everything, jobs and outbox included, when the work throws', async () => {
    const clinic = newClinic();
    const failure = pg.unitOfWork.withTransaction(clinic, async (stores) => {
      await stores.expectations.upsertByIdempotencyKey(clinic, makeExpectation(clinic));
      await stores.cases.create(clinic, makeCase(clinic));
      await stores.jobs.enqueue(clinic, { type: 'note.extract_plan', payload: {} });
      await stores.outbox.add(clinic, caseOpened(clinic, 'evt-1'));
      throw new Boom('after the writes');
    });
    await expect(failure).rejects.toThrow(Boom);
    for (const table of ['expectations', 'follow_up_cases', 'jobs', 'outbox']) {
      expect(await count(table, clinic)).toBe(0);
    }
  });

  it('rolls back when a statement fails, surfacing the domain error', async () => {
    const clinic = newClinic();
    const failure = pg.unitOfWork.withTransaction(clinic, async (stores) => {
      await stores.expectations.upsertByIdempotencyKey(clinic, makeExpectation(clinic));
      await stores.cases.create(clinic, makeCase(clinic, { dedupKey: 'same' }));
      await stores.cases.create(clinic, makeCase(clinic, { dedupKey: 'same' }));
    });
    await expect(failure).rejects.toMatchObject({ name: 'ConflictError' });
    expect(await count('expectations', clinic)).toBe(0);
  });

  it('reports a commit that Postgres turned into a rollback', async () => {
    const clinic = newClinic();
    const expectation = makeExpectation(clinic);
    const swallowed = pg.unitOfWork.withTransaction(clinic, async (stores) => {
      await stores.expectations.upsertByIdempotencyKey(clinic, expectation);
      await stores.cases.create(clinic, makeCase(clinic, { dedupKey: 'same' }));
      // A failed statement whose error the work ignores aborts the transaction.
      await stores.cases
        .create(clinic, makeCase(clinic, { dedupKey: 'same' }))
        .catch(() => undefined);
    });
    await expect(swallowed).rejects.toThrow(TransactionAbortedError);
    expect(await pg.expectations.get(clinic, expectation.id)).toBeUndefined();
  });

  it('scopes the transaction to the clinic through app.clinic_id', async () => {
    const clinic = newClinic();
    const setting = async () => {
      const { rows } = await pg
        .db()
        .query<{ value: string | null }>(
          `SELECT NULLIF(current_setting('app.clinic_id', true), '') AS value`,
        );
      return rows[0]?.value ?? null;
    };
    expect(await pg.unitOfWork.withTransaction(clinic, setting)).toBe(clinic);
    // `set_config(..., true)` is transaction-local: nothing leaks to the pooled connection.
    expect(await setting()).toBeNull();
  });

  it('reuses the transaction for nested calls, with savepoint semantics', async () => {
    const clinic = newClinic();
    const kept = makeExpectation(clinic);
    const discarded = makeExpectation(clinic);
    await pg.unitOfWork.withTransaction(clinic, async (outer) => {
      await outer.expectations.upsertByIdempotencyKey(clinic, kept);
      await pg.unitOfWork.withTransaction(clinic, async (inner) => {
        // Same transaction: the outer write is visible before commit.
        expect(await inner.expectations.get(clinic, kept.id)).toEqual(kept);
      });
      await expect(
        pg.unitOfWork.withTransaction(clinic, async (inner) => {
          await inner.expectations.upsertByIdempotencyKey(clinic, discarded);
          throw new Boom('nested');
        }),
      ).rejects.toThrow(Boom);
      // The nested failure rolled back only its own work; the outer unit goes on.
      expect(await outer.expectations.get(clinic, discarded.id)).toBeUndefined();
    });
    expect(await pg.expectations.get(clinic, kept.id)).toEqual(kept);
    expect(await pg.expectations.get(clinic, discarded.id)).toBeUndefined();
  });

  it('rejects a nested unit of work for another clinic', async () => {
    const [a, b] = [newClinic(), newClinic()];
    await expect(
      pg.unitOfWork.withTransaction(a, () =>
        pg.unitOfWork.withTransaction(b, () => Promise.resolve()),
      ),
    ).rejects.toThrow(TenantMismatchError);
  });

  it('makes pool-bound repositories join the ambient transaction', async () => {
    const clinic = newClinic();
    const expectation = makeExpectation(clinic);
    await expect(
      pg.unitOfWork.withTransaction(clinic, async () => {
        // `pg.expectations` is the pool-bound repository, not `stores.expectations`.
        await pg.expectations.upsertByIdempotencyKey(clinic, expectation);
        expect(await pg.expectations.get(clinic, expectation.id)).toEqual(expectation);
        throw new Boom('roll back');
      }),
    ).rejects.toThrow(Boom);
    expect(await pg.expectations.get(clinic, expectation.id)).toBeUndefined();
  });

  it('refuses to run a transaction-bound store after the unit finished', async () => {
    const clinic = newClinic();
    const leaked = await pg.unitOfWork.withTransaction(clinic, (stores) => Promise.resolve(stores));
    await expect(leaked.expectations.get(clinic, 'x' as never)).rejects.toThrow(
      TransactionClosedError,
    );
  });

  it('returns connections to the pool after commit and rollback', async () => {
    const clinic = newClinic();
    for (let index = 0; index < 20; index += 1) {
      await pg.unitOfWork
        .withTransaction(clinic, () =>
          index % 2 === 0 ? Promise.reject(new Boom('rollback')) : Promise.resolve(),
        )
        .catch(() => undefined);
    }
    expect(db.pool.totalCount).toBeLessThanOrEqual(5);
    expect(db.pool.waitingCount).toBe(0);
  });
});
