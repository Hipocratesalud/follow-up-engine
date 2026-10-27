import {
  CASE_STATUSES,
  CLINICAL_EVENT_TYPES,
  ConflictError,
  EXPECTATION_LAYERS,
  EXPECTATION_STATUSES,
  FakeClock,
  ICD10_SYSTEM,
  NotFoundError,
  TenantMismatchError,
  type CaseId,
  type ClinicalEvent,
  type ClinicId,
  type FeedbackId,
  type FollowUpCase,
  type PatientId,
  ZERO_BACKFILL_COUNTS,
} from '@follow-up-engine/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgresAdapters } from './adapters.ts';
import { hashApiKey } from './clinic-directory.ts';
import { InvalidCursorError } from './case-repository.ts';
import { at, BASE, makeCase, makeExpectation, newClinic, patient } from './test-fixtures.ts';
import {
  createIsolatedDatabase,
  databaseSuiteTitle,
  testDatabaseUrl,
  type IsolatedDatabase,
} from './testing.ts';

/** One event of every type, so the codec round-trip covers every `Date` field. */
function everyEventType(clinicId: ClinicId, patientId: PatientId): ClinicalEvent[] {
  const base = (type: string, day: number) => ({
    clinicId,
    patientId,
    source: { resourceType: 'Encounter', id: `enc-${type}` },
    encounterId: 'enc-1',
    occurredAt: at(day),
    idempotencyKey: `Encounter/enc-${type}/1#${type}`,
  });
  const loinc = { system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' };
  return [
    { ...base('encounter.finished', 0), type: 'encounter.finished', specialty: 'diabetology' },
    { ...base('appointment.booked', 1), type: 'appointment.booked', scheduledFor: at(90) },
    { ...base('appointment.cancelled', 2), type: 'appointment.cancelled', scheduledFor: at(90) },
    {
      ...base('service_request.created', 3),
      type: 'service_request.created',
      orderId: 'sr-1',
      code: loinc,
      category: 'laboratory',
    },
    {
      ...base('result.received', 4),
      type: 'result.received',
      basedOnOrderId: 'sr-1',
      code: loinc,
      interpretation: 'abnormal',
    },
    {
      ...base('medication.prescribed', 5),
      type: 'medication.prescribed',
      medication: { text: 'metformina 850 mg c/12h' },
      startAt: at(5),
      durationDays: 90,
    },
    {
      ...base('condition.recorded', 6),
      type: 'condition.recorded',
      code: { system: ICD10_SYSTEM, code: 'E11' },
      verification: 'confirmed',
    },
    {
      ...base('note.received', 7),
      type: 'note.received',
      documentId: 'doc-1',
      text: 'Pcte sintética. Plan: ctrl en 3 meses con HbA1c.',
      authoredAt: at(7),
    },
    {
      ...base('plan.extracted', 8),
      type: 'plan.extracted',
      sourceDocumentId: 'doc-1',
      items: [
        {
          kind: 'follow_up_visit',
          description: 'follow-up visit',
          dueAt: at(97),
          evidenceQuote: 'ctrl en 3 meses',
          confidence: 0.9,
        },
      ],
      extractor: { model: 'fake', promptVersion: 'plan-v1' },
    },
    { ...base('patient.opted_out', 9), type: 'patient.opted_out' },
  ];
}

describe.skipIf(testDatabaseUrl() === undefined)(
  databaseSuiteTitle('Postgres repositories'),
  () => {
    let db: IsolatedDatabase;
    let pg: PostgresAdapters;
    const clock = new FakeClock(BASE);

    beforeAll(async () => {
      db = await createIsolatedDatabase();
      pg = db.adapters({ clock });
    });

    afterAll(async () => {
      await db.dispose();
    });

    describe('ClinicalRecordRepository', () => {
      const resource = {
        resourceType: 'ServiceRequest',
        id: 'sr-1',
        status: 'active',
        code: { text: 'HbA1c' },
      };

      it('versions resources only when their content changes', async () => {
        const clinic = newClinic();
        const repo = pg.clinicalRecords;
        expect(await repo.saveResource(clinic, patient('p1'), resource, at(0))).toEqual({
          versionId: '1',
          changed: true,
        });
        // Same content with keys in another order: idempotent re-delivery.
        const reordered = {
          code: { text: 'HbA1c' },
          status: 'active',
          id: 'sr-1',
          resourceType: 'ServiceRequest',
        };
        expect(await repo.saveResource(clinic, patient('p1'), reordered, at(1))).toEqual({
          versionId: '1',
          changed: false,
        });
        expect(
          await repo.saveResource(
            clinic,
            patient('p1'),
            { ...resource, status: 'completed' },
            at(2),
          ),
        ).toEqual({ versionId: '2', changed: true });

        const stored = await repo.getResource(clinic, {
          resourceType: 'ServiceRequest',
          id: 'sr-1',
        });
        expect(stored).toEqual({
          patientId: 'p1',
          resource: { ...resource, status: 'completed' },
          versionId: '2',
          receivedAt: at(2),
        });
      });

      it('isolates resources per clinic', async () => {
        const [a, b] = [newClinic(), newClinic()];
        await pg.clinicalRecords.saveResource(a, patient('p1'), resource, at(0));
        expect(
          await pg.clinicalRecords.getResource(b, { resourceType: 'ServiceRequest', id: 'sr-1' }),
        ).toBeUndefined();
        expect(await pg.clinicalRecords.saveResource(b, patient('p1'), resource, at(0))).toEqual({
          versionId: '1',
          changed: true,
        });
      });

      it('round-trips every event type with its dates and skips known idempotency keys', async () => {
        const clinic = newClinic();
        const events = everyEventType(clinic, patient('p1'));
        expect(events.map((event) => event.type)).toEqual([...CLINICAL_EVENT_TYPES]);

        expect(await pg.clinicalRecords.appendEvents(clinic, events)).toEqual({ inserted: 10 });
        expect(await pg.clinicalRecords.appendEvents(clinic, events)).toEqual({ inserted: 0 });
        // Duplicates inside one batch count once.
        const fresh = { ...events[0], idempotencyKey: 'dup' } as ClinicalEvent;
        expect(await pg.clinicalRecords.appendEvents(clinic, [fresh, fresh])).toEqual({
          inserted: 1,
        });

        const stored = await pg.clinicalRecords.listEventsForPatient(clinic, patient('p1'), {
          types: [...CLINICAL_EVENT_TYPES],
        });
        expect(stored.filter((event) => event.idempotencyKey !== 'dup')).toEqual(events);
      });

      it('lists a patient’s events chronologically, ties in insertion order, with filters', async () => {
        const clinic = newClinic();
        const [first, second, third] = everyEventType(clinic, patient('p1'));
        if (first === undefined || second === undefined || third === undefined) {
          throw new Error('fixture');
        }
        const tieA = { ...third, occurredAt: at(1), idempotencyKey: 'tie-a' };
        const tieB = { ...first, occurredAt: at(1), idempotencyKey: 'tie-b' };
        await pg.clinicalRecords.appendEvents(clinic, [second, tieA, tieB, first]);
        await pg.clinicalRecords.appendEvents(clinic, [
          { ...first, patientId: patient('p2'), idempotencyKey: 'other-patient' },
        ]);

        const all = await pg.clinicalRecords.listEventsForPatient(clinic, patient('p1'));
        expect(all.map((event) => event.idempotencyKey)).toEqual([
          first.idempotencyKey,
          second.idempotencyKey,
          'tie-a',
          'tie-b',
        ]);
        const window = await pg.clinicalRecords.listEventsForPatient(clinic, patient('p1'), {
          since: at(1),
          until: at(1, 1),
        });
        expect(window.map((event) => event.idempotencyKey)).toEqual([
          second.idempotencyKey,
          'tie-a',
          'tie-b',
        ]);
        const typed = await pg.clinicalRecords.listEventsForPatient(clinic, patient('p1'), {
          types: ['encounter.finished'],
        });
        expect(typed.map((event) => event.idempotencyKey)).toEqual([first.idempotencyKey, 'tie-b']);
        expect(await pg.clinicalRecords.listEventsForPatient(newClinic(), patient('p1'))).toEqual(
          [],
        );
      });

      it('rejects events of another clinic', async () => {
        const [a, b] = [newClinic(), newClinic()];
        await expect(
          pg.clinicalRecords.appendEvents(a, everyEventType(b, patient('p1'))),
        ).rejects.toThrow(TenantMismatchError);
      });

      it('pages through patient ids in byte order', async () => {
        const clinic = newClinic();
        const ids = ['pat-B', 'pat-a', 'pat-10', 'pat-2', 'pat-1'];
        const [template] = everyEventType(clinic, patient('x'));
        if (template === undefined) {
          throw new Error('fixture');
        }
        await pg.clinicalRecords.appendEvents(
          clinic,
          ids.flatMap((id) => [
            { ...template, patientId: patient(id), idempotencyKey: `${id}-1` },
            { ...template, patientId: patient(id), idempotencyKey: `${id}-2` },
          ]),
        );
        const other = newClinic();
        await pg.clinicalRecords.appendEvents(other, [
          { ...template, clinicId: other, patientId: patient('pat-0'), idempotencyKey: 'x' },
        ]);

        const first = await pg.clinicalRecords.listPatientIds(clinic, { limit: 2 });
        expect(first).toEqual({ patientIds: ['pat-1', 'pat-10'], next: 'pat-10' });
        const second = await pg.clinicalRecords.listPatientIds(clinic, {
          after: first.next ?? patient('unreachable'),
          limit: 2,
        });
        expect(second).toEqual({ patientIds: ['pat-2', 'pat-B'], next: 'pat-B' });
        const last = await pg.clinicalRecords.listPatientIds(clinic, {
          after: second.next ?? patient('unreachable'),
          limit: 2,
        });
        expect(last).toEqual({ patientIds: ['pat-a'] });
        expect(await pg.clinicalRecords.listPatientIds(newClinic(), { limit: 10 })).toEqual({
          patientIds: [],
        });
      });
    });

    describe('ExpectationRepository', () => {
      it('inserts once per idempotency key and returns the stored one untouched', async () => {
        const clinic = newClinic();
        const original = makeExpectation(clinic, {
          evidence: { quote: 'ctrl en 3 meses', sourceDocumentId: 'doc-1' },
          protocolId: 'dm2',
          protocolVersion: '1',
          layer: 'protocol',
        });
        expect(await pg.expectations.upsertByIdempotencyKey(clinic, original)).toEqual({
          expectation: original,
          created: true,
        });
        const retry = makeExpectation(clinic, {
          idempotencyKey: original.idempotencyKey,
          dueAt: at(99),
        });
        expect(await pg.expectations.upsertByIdempotencyKey(clinic, retry)).toEqual({
          expectation: original,
          created: false,
        });
        expect(await pg.expectations.get(clinic, retry.id)).toBeUndefined();
        // Another clinic may use the same key.
        const other = newClinic();
        const elsewhere = { ...original, clinicId: other };
        expect((await pg.expectations.upsertByIdempotencyKey(other, elsewhere)).created).toBe(true);
      });

      it('rejects a second expectation with an existing id but another key', async () => {
        const clinic = newClinic();
        const first = makeExpectation(clinic);
        await pg.expectations.upsertByIdempotencyKey(clinic, first);
        await expect(
          pg.expectations.upsertByIdempotencyKey(clinic, { ...first, idempotencyKey: 'other' }),
        ).rejects.toThrow(ConflictError);
      });

      it('finds due open expectations by dueAt ascending, up to the limit', async () => {
        const clinic = newClinic();
        const days = [5, 1, 3, 2, 40];
        for (const day of days) {
          await pg.expectations.upsertByIdempotencyKey(
            clinic,
            makeExpectation(clinic, { id: `exp-${String(day)}` as never, dueAt: at(day) }),
          );
        }
        await pg.expectations.upsertByIdempotencyKey(
          clinic,
          makeExpectation(clinic, { id: 'exp-closed' as never, dueAt: at(0), status: 'fulfilled' }),
        );
        const other = newClinic();
        await pg.expectations.upsertByIdempotencyKey(
          other,
          makeExpectation(other, { dueAt: at(0) }),
        );

        const due = await pg.expectations.findDue(clinic, at(5), 3);
        expect(due.map((expectation) => expectation.id)).toEqual(['exp-1', 'exp-2', 'exp-3']);
        const all = await pg.expectations.findDue(clinic, at(5), 10);
        expect(all.map((expectation) => expectation.id)).toEqual([
          'exp-1',
          'exp-2',
          'exp-3',
          'exp-5',
        ]);
        expect(await pg.expectations.findDue(newClinic(), at(100), 10)).toEqual([]);
        expect(await pg.expectations.findDue(other, at(100), 10)).toHaveLength(1);
      });

      it('lists a patient’s open expectations by dueAt and updates them', async () => {
        const clinic = newClinic();
        const later = makeExpectation(clinic, { dueAt: at(20) });
        const sooner = makeExpectation(clinic, { dueAt: at(10) });
        const otherPatient = makeExpectation(clinic, { patientId: patient('pat-2') });
        for (const expectation of [later, sooner, otherPatient]) {
          await pg.expectations.upsertByIdempotencyKey(clinic, expectation);
        }
        expect(await pg.expectations.findOpenByPatient(clinic, patient('pat-1'))).toEqual([
          sooner,
          later,
        ]);

        const fulfilled = {
          ...sooner,
          status: 'fulfilled' as const,
          closedReason: 'fulfilled_by_result',
          closedAt: at(11),
          caseId: 'case-1' as CaseId,
          updatedAt: at(11),
        };
        await pg.expectations.update(clinic, fulfilled);
        expect(await pg.expectations.get(clinic, sooner.id)).toEqual(fulfilled);
        expect(await pg.expectations.findOpenByPatient(clinic, patient('pat-1'))).toEqual([later]);
      });

      it('persists every layer and status the core defines', async () => {
        const clinic = newClinic();
        for (const layer of EXPECTATION_LAYERS) {
          for (const status of EXPECTATION_STATUSES) {
            const expectation = makeExpectation(clinic, { layer, status });
            await pg.expectations.upsertByIdempotencyKey(clinic, expectation);
            expect(await pg.expectations.get(clinic, expectation.id)).toEqual(expectation);
          }
        }
      });

      it('enforces the clinic of the call', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const expectation = makeExpectation(a);
        await expect(pg.expectations.upsertByIdempotencyKey(b, expectation)).rejects.toThrow(
          TenantMismatchError,
        );
        await pg.expectations.upsertByIdempotencyKey(a, expectation);
        expect(await pg.expectations.get(b, expectation.id)).toBeUndefined();
        expect(await pg.expectations.findOpenByPatient(b, expectation.patientId)).toEqual([]);
        await expect(pg.expectations.update(b, expectation)).rejects.toThrow(TenantMismatchError);
        await expect(pg.expectations.update(b, { ...expectation, clinicId: b })).rejects.toThrow(
          NotFoundError,
        );
      });
    });

    describe('CaseRepository', () => {
      it('allows one active case per dedup key and a new one once it is closed', async () => {
        const clinic = newClinic();
        const first = makeCase(clinic, { dedupKey: 'pat-1:lab' });
        await pg.cases.create(clinic, first);
        expect(await pg.cases.findActiveByDedupKey(clinic, 'pat-1:lab')).toEqual(first);

        const duplicate = makeCase(clinic, { dedupKey: 'pat-1:lab', status: 'snoozed' });
        const error = await pg.cases.create(clinic, duplicate).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({ entity: 'FollowUpCase', key: 'pat-1:lab' });
        expect(await pg.cases.get(clinic, duplicate.id)).toBeUndefined();

        // Same key in another clinic is independent.
        const other = newClinic();
        await pg.cases.create(other, { ...duplicate, clinicId: other });

        const resolved: FollowUpCase = {
          ...first,
          status: 'resolved',
          resolution: { kind: 'fulfilled', resolvedAt: at(3), resolvedBy: 'user-1', note: 'ok' },
          updatedAt: at(3),
        };
        await pg.cases.update(clinic, resolved);
        expect(await pg.cases.get(clinic, first.id)).toEqual(resolved);
        expect(await pg.cases.findActiveByDedupKey(clinic, 'pat-1:lab')).toBeUndefined();
        await pg.cases.create(clinic, duplicate);
        expect(await pg.cases.findActiveByDedupKey(clinic, 'pat-1:lab')).toEqual(duplicate);

        // Reopening the resolved one would make two active cases.
        await expect(pg.cases.update(clinic, { ...resolved, status: 'open' })).rejects.toThrow(
          ConflictError,
        );
      });

      it('rejects a duplicate id, unknown updates and other clinics', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const value = makeCase(a);
        await pg.cases.create(a, value);
        await expect(pg.cases.create(a, { ...value, dedupKey: 'other' })).rejects.toThrow(
          ConflictError,
        );
        await expect(pg.cases.update(a, makeCase(a, { dedupKey: 'x' }))).rejects.toThrow(
          NotFoundError,
        );
        await expect(pg.cases.create(b, value)).rejects.toThrow(TenantMismatchError);
        expect(await pg.cases.get(b, value.id)).toBeUndefined();
        expect(await pg.cases.findActiveByDedupKey(b, value.dedupKey)).toBeUndefined();
        expect((await pg.cases.list(b, { limit: 10 })).items).toEqual([]);
      });

      it('persists every status the core defines', async () => {
        const clinic = newClinic();
        for (const status of CASE_STATUSES) {
          const value = makeCase(clinic, { status, dedupKey: `key-${status}` });
          await pg.cases.create(clinic, value);
          expect(await pg.cases.get(clinic, value.id)).toEqual(value);
        }
      });

      describe('list', () => {
        let clinic: ClinicId;
        let cases: FollowUpCase[];

        beforeAll(async () => {
          clinic = newClinic();
          cases = [
            makeCase(clinic, { id: 'c1' as CaseId, dedupKey: 'k1', priority: 1, createdAt: at(1) }),
            makeCase(clinic, {
              id: 'c2' as CaseId,
              dedupKey: 'k2',
              priority: 5,
              createdAt: at(2),
              nextActionAt: at(9),
            }),
            makeCase(clinic, {
              id: 'c3' as CaseId,
              dedupKey: 'k3',
              priority: 5,
              createdAt: at(1),
              nextActionAt: at(4),
            }),
            makeCase(clinic, {
              id: 'c4' as CaseId,
              dedupKey: 'k4',
              priority: 3,
              createdAt: at(3),
              assignee: 'nurse-1',
              origin: 'backfill',
              releaseAt: at(10),
            }),
            makeCase(clinic, {
              id: 'c5' as CaseId,
              dedupKey: 'k5',
              priority: 9,
              createdAt: at(4),
              status: 'resolved',
              patientId: patient('pat-2'),
            }),
          ];
          for (const value of cases) {
            await pg.cases.create(clinic, value);
          }
        });

        async function collect(query: Parameters<PostgresAdapters['cases']['list']>[1]) {
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await pg.cases.list(clinic, {
              ...query,
              ...(cursor === undefined ? {} : { cursor }),
            });
            expect(page.items.length).toBeLessThanOrEqual(query.limit);
            ids.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
          } while (cursor !== undefined);
          return ids;
        }

        it('orders by priority desc then createdAt asc by default, paging with cursors', async () => {
          expect(await collect({ limit: 2 })).toEqual(['c5', 'c3', 'c2', 'c4', 'c1']);
          expect(await collect({ limit: 10 })).toEqual(['c5', 'c3', 'c2', 'c4', 'c1']);
        });

        it('orders by createdAt and by nextActionAt (unset last)', async () => {
          expect(await collect({ limit: 2, orderBy: 'created_at' })).toEqual([
            'c1',
            'c3',
            'c2',
            'c4',
            'c5',
          ]);
          expect(await collect({ limit: 1, orderBy: 'next_action_at' })).toEqual([
            'c3',
            'c2',
            'c1',
            'c4',
            'c5',
          ]);
        });

        it('filters by status, patient, assignee, origin and release', async () => {
          expect(await collect({ limit: 10, statuses: ['open'] })).toEqual([
            'c3',
            'c2',
            'c4',
            'c1',
          ]);
          expect(await collect({ limit: 10, patientId: patient('pat-2') })).toEqual(['c5']);
          expect(await collect({ limit: 10, assignee: 'nurse-1' })).toEqual(['c4']);
          expect(await collect({ limit: 10, origin: 'backfill' })).toEqual(['c4']);
          expect(await collect({ limit: 10, statuses: ['open'], releasedAsOf: at(9) })).toEqual([
            'c3',
            'c2',
            'c1',
          ]);
          expect(await collect({ limit: 10, statuses: ['open'], releasedAsOf: at(10) })).toEqual([
            'c3',
            'c2',
            'c4',
            'c1',
          ]);
        });

        it('returns stored cases intact and rejects foreign cursors', async () => {
          const page = await pg.cases.list(clinic, { limit: 10, orderBy: 'created_at' });
          expect(page.items).toEqual([cases[0], cases[2], cases[1], cases[3], cases[4]]);
          const { nextCursor } = await pg.cases.list(clinic, { limit: 1 });
          await expect(
            pg.cases.list(clinic, {
              limit: 1,
              orderBy: 'created_at',
              ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
            }),
          ).rejects.toThrow(InvalidCursorError);
          await expect(pg.cases.list(clinic, { limit: 1, cursor: 'garbage' })).rejects.toThrow(
            InvalidCursorError,
          );
        });
      });

      it('finds active cases due for action by that instant', async () => {
        const clinic = newClinic();
        const values = [
          makeCase(clinic, { id: 'due-late' as CaseId, dedupKey: 'a', nextActionAt: at(4) }),
          makeCase(clinic, {
            id: 'due-early' as CaseId,
            dedupKey: 'b',
            status: 'notified',
            nextActionAt: at(1),
          }),
          makeCase(clinic, { id: 'not-yet' as CaseId, dedupKey: 'c', nextActionAt: at(9) }),
          makeCase(clinic, { id: 'no-action' as CaseId, dedupKey: 'd' }),
          makeCase(clinic, {
            id: 'snooze-over' as CaseId,
            dedupKey: 'e',
            status: 'snoozed',
            snoozedUntil: at(2),
          }),
          makeCase(clinic, {
            id: 'snoozing' as CaseId,
            dedupKey: 'f',
            status: 'snoozed',
            snoozedUntil: at(8),
          }),
          makeCase(clinic, {
            id: 'closed' as CaseId,
            dedupKey: 'g',
            status: 'resolved',
            nextActionAt: at(0),
          }),
        ];
        for (const value of values) {
          await pg.cases.create(clinic, value);
        }
        const due = await pg.cases.findDueForAction(clinic, at(5), 10);
        expect(due.map((value) => value.id)).toEqual(['due-early', 'snooze-over', 'due-late']);
        expect(
          (await pg.cases.findDueForAction(clinic, at(5), 2)).map((value) => value.id),
        ).toEqual(['due-early', 'snooze-over']);
        expect(await pg.cases.findDueForAction(newClinic(), at(50), 10)).toEqual([]);
      });
    });

    describe('AuditLog and FeedbackRepository', () => {
      it('appends case events and lists them chronologically per clinic', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const caseId = 'case-1' as CaseId;
        const opened = {
          clinicId: a,
          caseId,
          type: 'opened' as const,
          actor: { type: 'rule' as const, id: 'lab_order_result_pending' },
          payload: { reasons: ['lab_result_pending'] },
          at: at(1),
        };
        const notified = {
          ...opened,
          type: 'notified' as const,
          actor: { type: 'system' as const },
          payload: {},
          at: at(2),
        };
        await pg.audit.append(a, notified);
        await pg.audit.append(a, opened);
        expect(await pg.audit.listForCase(a, caseId)).toEqual([opened, notified]);
        expect(await pg.audit.listForCase(b, caseId)).toEqual([]);
        await expect(pg.audit.append(b, opened)).rejects.toThrow(TenantMismatchError);
      });

      it('records feedback once per id and lists it per case and since a date', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const caseId = 'case-1' as CaseId;
        const useful = {
          id: 'fb-1' as FeedbackId,
          clinicId: a,
          caseId,
          useful: true,
          createdAt: at(1),
        };
        const notUseful = {
          id: 'fb-2' as FeedbackId,
          clinicId: a,
          caseId,
          useful: false,
          reason: 'wrong_interval' as const,
          comment: 'too early',
          authorId: 'doc-1',
          createdAt: at(3),
        };
        await pg.feedback.record(a, notUseful);
        await pg.feedback.record(a, useful);
        await expect(pg.feedback.record(a, useful)).rejects.toThrow(ConflictError);
        await expect(pg.feedback.record(b, useful)).rejects.toThrow(TenantMismatchError);
        expect(await pg.feedback.listForCase(a, caseId)).toEqual([useful, notUseful]);
        expect(await pg.feedback.listSince(a, at(2), 10)).toEqual([notUseful]);
        expect(await pg.feedback.listSince(a, at(0), 1)).toEqual([useful]);
        expect(await pg.feedback.listForCase(b, caseId)).toEqual([]);
        expect(await pg.feedback.listSince(b, at(0), 10)).toEqual([]);
      });
    });

    describe('ConditionRepository and QualityFindingRepository', () => {
      it('upserts conditions per patient and code, filtered by status', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const probable = {
          clinicId: a,
          patientId: patient('pat-1'),
          code: { system: ICD10_SYSTEM, code: 'E11', display: 'Type 2 diabetes' },
          status: 'probable' as const,
          confidence: 0.7,
          sourceType: 'inferred_from_medication' as const,
          source: { resourceType: 'MedicationRequest', id: 'mr-1' },
          updatedAt: at(1),
        };
        const hypertension = {
          ...probable,
          code: { system: ICD10_SYSTEM, code: 'I10' },
          status: 'confirmed' as const,
          confidence: 1,
          sourceType: 'recorded' as const,
        };
        await pg.conditions.upsert(a, probable);
        await pg.conditions.upsert(a, hypertension);
        const confirmed = {
          ...probable,
          status: 'confirmed' as const,
          confirmedBy: 'doc-1',
          updatedAt: at(2),
        };
        await pg.conditions.upsert(a, confirmed);

        expect(await pg.conditions.listByPatient(a, patient('pat-1'))).toEqual([
          confirmed,
          hypertension,
        ]);
        expect(await pg.conditions.listByPatient(a, patient('pat-1'), ['probable'])).toEqual([]);
        // Replacing drops fields the new value no longer has.
        const { confirmedBy, ...withoutConfirmer } = confirmed;
        expect(confirmedBy).toBe('doc-1');
        await pg.conditions.upsert(a, withoutConfirmer);
        expect(await pg.conditions.listByPatient(a, patient('pat-1'), ['confirmed'])).toEqual([
          withoutConfirmer,
          hypertension,
        ]);
        expect(await pg.conditions.listByPatient(b, patient('pat-1'))).toEqual([]);
        await expect(pg.conditions.upsert(b, probable)).rejects.toThrow(TenantMismatchError);
      });

      it('saves quality findings idempotently on id', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const finding = {
          id: 'qf-1',
          clinicId: a,
          patientId: patient('pat-1'),
          kind: 'note_without_plan' as const,
          source: { resourceType: 'DocumentReference', id: 'doc-1' },
          detectedAt: at(1),
        };
        await pg.qualityFindings.save(a, finding);
        await pg.qualityFindings.save(a, { ...finding, detectedAt: at(5) });
        expect(await pg.qualityFindings.listByPatient(a, patient('pat-1'))).toEqual([finding]);
        expect(await pg.qualityFindings.listByPatient(b, patient('pat-1'))).toEqual([]);
        await expect(pg.qualityFindings.save(b, finding)).rejects.toThrow(TenantMismatchError);
      });
    });

    describe('ClinicDirectory', () => {
      it('registers clinics, fills default settings and finds them by API key hash', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const keyHash = hashApiKey(`synthetic-key-${a}`);
        await pg.clinics.register({
          id: a,
          name: 'Clínica Demo',
          settings: { allowPatientContact: true, timezone: 'America/Caracas' },
          apiKeyHash: keyHash,
        });
        await pg.clinics.register({ id: b, name: 'Inactive', active: false });

        const clinic = await pg.clinics.get(a);
        expect(clinic).toEqual({
          id: a,
          name: 'Clínica Demo',
          active: true,
          settings: {
            allowPatientContact: true,
            dailyCaseCapPerOwner: 20,
            backfillNotifyMaxAgeDays: 730,
            llmMonthlyBudgetUsd: 50,
            timezone: 'America/Caracas',
          },
        });
        expect(await pg.clinics.findByApiKeyHash(keyHash)).toEqual(clinic);
        expect(await pg.clinics.findByApiKeyHash(hashApiKey('unknown'))).toBeUndefined();
        const active = (await pg.clinics.listActive()).map((value) => value.id);
        expect(active).toContain(a);
        expect(active).not.toContain(b);

        // Re-registering keeps the key unless a new one is given.
        await pg.clinics.register({ id: a, name: 'Renamed' });
        expect((await pg.clinics.findByApiKeyHash(keyHash))?.name).toBe('Renamed');
      });
    });

    describe('LlmUsageLog', () => {
      it('sums costs per clinic since a date, idempotent on call id', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const call = {
          callId: 'call-1',
          clinicId: a,
          task: 'plan_extraction',
          promptVersion: 'plan-v1',
          provider: 'fake',
          model: 'muse-spark',
          inputTokens: 1200,
          outputTokens: 300,
          costUsd: 0.0000123,
          latencyMs: 812.4,
          ok: true,
          at: at(1),
        };
        await pg.llmUsage.record(call);
        await pg.llmUsage.record(call);
        await pg.llmUsage.record({
          ...call,
          callId: 'call-2',
          costUsd: 0.1,
          ok: false,
          error: 'timeout',
          at: at(3),
        });
        await pg.llmUsage.record({ ...call, clinicId: b, callId: 'call-3', costUsd: 5 });

        expect(await pg.llmUsage.totalCostUsd(a, at(0))).toBeCloseTo(0.1000123, 10);
        expect(await pg.llmUsage.totalCostUsd(a, at(2))).toBeCloseTo(0.1, 10);
        expect(await pg.llmUsage.totalCostUsd(b, at(0))).toBe(5);
        expect(await pg.llmUsage.totalCostUsd(newClinic(), at(0))).toBe(0);
      });
    });

    describe('BackfillProgressStore', () => {
      it('tracks one running run per clinic with a resumable cursor', async () => {
        const [a, b] = [newClinic(), newClinic()];
        const started = await pg.backfillProgress.start(a, 'run-1', { now: at(0) });
        expect(started).toMatchObject({ status: 'running', patientsScanned: 0 });
        expect(started.cursor).toBeUndefined();
        await expect(pg.backfillProgress.start(a, 'run-2', { now: at(0) })).rejects.toThrow(
          ConflictError,
        );
        await pg.backfillProgress.start(b, 'run-1', { now: at(0) });

        await pg.backfillProgress.advance(a, 'run-1', {
          cursor: patient('pat-1'),
          delta: {
            ...ZERO_BACKFILL_COUNTS,
            patientsScanned: 100,
            expectationsCreated: 40,
            casesOpened: 7,
            llmCostUsd: 0.1000123,
          },
          now: at(1),
        });
        const advanced = await pg.backfillProgress.advance(a, 'run-1', {
          cursor: patient('pat-2'),
          delta: {
            ...ZERO_BACKFILL_COUNTS,
            patientsScanned: 50,
            expectationsCreated: 10,
            casesOpened: 1,
            llmCostUsd: 0.2,
          },
          now: at(2),
        });
        expect(advanced).toMatchObject({
          cursor: 'pat-2',
          patientsScanned: 150,
          expectationsCreated: 50,
          casesOpened: 8,
          updatedAt: at(2),
        });
        // numeric(20, 10): no float drift when summing costs.
        expect(advanced.llmCostUsd).toBe(0.3000123);
        expect(await pg.backfillProgress.findRunning(a)).toEqual(advanced);

        const done = await pg.backfillProgress.finish(a, 'run-1', {
          status: 'completed',
          now: at(3),
        });
        expect(done).toMatchObject({ status: 'completed', finishedAt: at(3) });
        expect(await pg.backfillProgress.findRunning(a)).toBeUndefined();
        await expect(
          pg.backfillProgress.advance(a, 'run-1', {
            cursor: patient('pat-3'),
            delta: { ...ZERO_BACKFILL_COUNTS, patientsScanned: 1 },
            now: at(4),
          }),
        ).rejects.toThrow(NotFoundError);
        expect((await pg.backfillProgress.get(b, 'run-1'))?.status).toBe('running');
        expect(await pg.backfillProgress.get(newClinic(), 'run-1')).toBeUndefined();
      });
    });
  },
);
