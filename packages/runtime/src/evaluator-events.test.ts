import { clinicId } from '@follow-up-engine/core';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  type IsolatedDatabase,
  testDatabaseUrl,
} from '@follow-up-engine/adapter-postgres/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type EvaluatorEventStore,
  MemoryEvaluatorEventStore,
  PostgresEvaluatorEventStore,
} from './evaluator-events.ts';

const CLINIC_A = clinicId('clinic-a');
const CLINIC_B = clinicId('lab-abc123');

function sharedBehavior(name: string, makeStore: () => EvaluatorEventStore): void {
  describe(name, () => {
    it('appends and lists, newest first, scoped by clinic and evaluator', async () => {
      const store = makeStore();
      await store.record({
        clinicId: CLINIC_A,
        evaluatorEmail: 'doctor@example.com',
        action: 'login',
        simulatedAt: new Date('2026-01-05T00:00:00Z'),
        occurredAt: new Date('2026-01-05T00:00:01Z'),
      });
      await store.record({
        clinicId: CLINIC_B,
        evaluatorEmail: 'doctor@example.com',
        action: 'lab_record_added',
        patientId: 'pat-1' as never,
        payload: { kind: 'order' },
        simulatedAt: new Date('2026-01-05T01:00:00Z'),
        occurredAt: new Date('2026-01-05T01:00:01Z'),
      });
      await store.record({
        clinicId: CLINIC_A,
        evaluatorEmail: 'other@example.com',
        action: 'case_feedback',
        simulatedAt: new Date('2026-01-05T02:00:00Z'),
        occurredAt: new Date('2026-01-05T02:00:01Z'),
      });

      const all = await store.list({ limit: 10 });
      expect(all.items.map((event) => event.action)).toEqual([
        'case_feedback',
        'lab_record_added',
        'login',
      ]);

      const byClinic = await store.list({ clinicId: CLINIC_B, limit: 10 });
      expect(byClinic.items).toHaveLength(1);
      expect(byClinic.items[0]?.payload).toEqual({ kind: 'order' });

      const byEvaluator = await store.list({ evaluatorEmail: 'doctor@example.com', limit: 10 });
      expect(byEvaluator.items.map((event) => event.action).sort()).toEqual([
        'lab_record_added',
        'login',
      ]);
    });

    it('paginates with a cursor', async () => {
      const store = makeStore();
      for (let index = 0; index < 5; index += 1) {
        await store.record({
          clinicId: CLINIC_A,
          evaluatorEmail: 'doctor@example.com',
          action: 'login',
          simulatedAt: new Date(2026, 0, 5, index),
          occurredAt: new Date(2026, 0, 5, index),
        });
      }
      const first = await store.list({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(5);
      expect(first.nextCursor).toBeDefined();
      const second = await store.list({
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      });
      expect(second.items).toHaveLength(2);
      const third = await store.list({
        limit: 2,
        ...(second.nextCursor === undefined ? {} : { cursor: second.nextCursor }),
      });
      expect(third.items).toHaveLength(1);
      expect(third.nextCursor).toBeUndefined();
    });

    it('summarizes every evaluator seen: last seen, counts by action', async () => {
      const store = makeStore();
      await store.record({
        clinicId: CLINIC_A,
        evaluatorEmail: 'doctor@example.com',
        action: 'login',
        simulatedAt: new Date('2026-01-05T00:00:00Z'),
        occurredAt: new Date('2026-01-05T00:00:00Z'),
      });
      await store.record({
        clinicId: CLINIC_A,
        evaluatorEmail: 'doctor@example.com',
        action: 'case_feedback',
        simulatedAt: new Date('2026-01-06T00:00:00Z'),
        occurredAt: new Date('2026-01-06T00:00:00Z'),
      });
      await store.record({
        clinicId: CLINIC_A,
        evaluatorEmail: 'other@example.com',
        action: 'login',
        simulatedAt: new Date('2026-01-07T00:00:00Z'),
        occurredAt: new Date('2026-01-07T00:00:00Z'),
      });

      const summaries = await store.summary();
      expect(summaries.map((row) => row.evaluatorEmail)).toEqual([
        'other@example.com',
        'doctor@example.com',
      ]);
      const doctor = summaries.find((row) => row.evaluatorEmail === 'doctor@example.com');
      expect(doctor?.total).toBe(2);
      expect(doctor?.byAction).toMatchObject({ login: 1, case_feedback: 1 });
      expect(doctor?.firstSeenAt.toISOString()).toBe('2026-01-05T00:00:00.000Z');
      expect(doctor?.lastSeenAt.toISOString()).toBe('2026-01-06T00:00:00.000Z');
    });
  });
}

sharedBehavior('MemoryEvaluatorEventStore', () => new MemoryEvaluatorEventStore());

describe.skipIf(testDatabaseUrl() === undefined)(
  databaseSuiteTitle('PostgresEvaluatorEventStore (migration 0016)'),
  () => {
    let db: IsolatedDatabase;

    beforeAll(async () => {
      db = await createIsolatedDatabase();
    });

    afterAll(async () => {
      await db.dispose();
    });

    afterEach(async () => {
      await db.pool.query(`DELETE FROM "${db.schema}".evaluator_events`);
    });

    function store(): PostgresEvaluatorEventStore {
      return new PostgresEvaluatorEventStore(db.adapters().db, db.schema);
    }

    sharedBehavior('over Postgres', store);

    it('enables row-level security on the table (RLS-by-default, like api_keys)', async () => {
      const { rows } = await db.pool.query<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class
         WHERE relname = 'evaluator_events'
           AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
        [db.schema],
      );
      expect(rows[0]?.relrowsecurity).toBe(true);
    });
  },
);
