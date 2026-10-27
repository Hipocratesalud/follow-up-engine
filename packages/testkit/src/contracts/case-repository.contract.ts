import {
  type CaseRepository,
  expectationId,
  type FollowUpCase,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aCase } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  useSubject,
} from './harness.ts';

/** Contract every {@link CaseRepository} adapter must pass. */
export function describeCaseRepositoryContract(
  name: string,
  makeSubject: MakeSubject<CaseRepository>,
): void {
  describe(`CaseRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    async function createAll(clinic: FollowUpCase['clinicId'], cases: readonly FollowUpCase[]) {
      for (const c of cases) await repo().create(clinic, c);
    }

    it('creates a case and reads it back', async () => {
      const { a } = freshClinics();
      const c = aCase(a, { assignee: 'user-1', nextActionAt: at(2), releaseAt: at(1) });
      await repo().create(a, c);
      expect(await repo().get(a, c.id)).toEqual(c);
    });

    it('round-trips every optional field', async () => {
      const { a } = freshClinics();
      const c = aCase(a, {
        reasons: [
          { expectationId: expectationId('exp-1'), reasonCode: 'lab_order_result_pending' },
          { expectationId: expectationId('exp-2'), reasonCode: 'doctor_plan_followup' },
        ],
        status: 'resolved',
        assignee: 'prac-1',
        escalationStep: 3,
        snoozedUntil: at(4),
        releaseAt: at(1),
        origin: 'backfill',
        resolution: { kind: 'handled_outside', resolvedAt: at(6), resolvedBy: 'u-1', note: 'ok' },
        updatedAt: at(6),
      });
      await repo().create(a, c);
      expect(await repo().get(a, c.id)).toEqual(c);
    });

    it('round-trips the pinned escalation policy and a dismissal reason', async () => {
      const { a } = freshClinics();
      const c = aCase(a, { escalationPolicyId: 'default_v2' });
      await repo().create(a, c);
      expect(await repo().get(a, c.id)).toEqual(c);
      const dismissed = {
        ...c,
        status: 'dismissed' as const,
        resolution: {
          kind: 'not_needed' as const,
          resolvedAt: at(3),
          resolvedBy: 'u-1',
          dismissReason: 'not_applicable_to_patient' as const,
          note: 'no aplica',
        },
        updatedAt: at(3),
      };
      await repo().update(a, dismissed);
      expect(await repo().get(a, c.id)).toEqual(dismissed);
    });

    it('allows a single active case per dedupKey', async () => {
      const { a } = freshClinics();
      const first = aCase(a, { dedupKey: 'pat-1:labs' });
      await repo().create(a, first);
      expect(await repo().findActiveByDedupKey(a, 'pat-1:labs')).toEqual(first);
      await expectRejectsWithName(
        repo().create(a, aCase(a, { dedupKey: 'pat-1:labs' })),
        'ConflictError',
      );
    });

    it('allows a new active case once the previous one is closed', async () => {
      const { a } = freshClinics();
      const first = aCase(a, { dedupKey: 'pat-1:visit' });
      await repo().create(a, first);
      await repo().update(a, {
        ...first,
        status: 'resolved',
        resolution: { kind: 'fulfilled', resolvedAt: at(5) },
        updatedAt: at(5),
      });
      expect(await repo().findActiveByDedupKey(a, 'pat-1:visit')).toBeUndefined();
      const second = aCase(a, { dedupKey: 'pat-1:visit', createdAt: at(6), updatedAt: at(6) });
      await repo().create(a, second);
      expect(await repo().findActiveByDedupKey(a, 'pat-1:visit')).toEqual(second);
    });

    it('treats every active status as active for dedup', async () => {
      const { a } = freshClinics();
      for (const status of ['open', 'notified', 'snoozed', 'escalated'] as const) {
        const key = `pat-1:${status}`;
        await repo().create(a, aCase(a, { dedupKey: key, status }));
        expect((await repo().findActiveByDedupKey(a, key))?.status).toBe(status);
      }
      await repo().create(a, aCase(a, { dedupKey: 'pat-1:lost', status: 'lost_to_follow_up' }));
      expect(await repo().findActiveByDedupKey(a, 'pat-1:lost')).toBeUndefined();
    });

    it('updates a case and rejects updating an unknown one', async () => {
      const { a } = freshClinics();
      const c = aCase(a);
      await repo().create(a, c);
      const escalated = {
        ...c,
        status: 'escalated' as const,
        escalationStep: 1,
        priority: 70,
        updatedAt: at(3),
      };
      await repo().update(a, escalated);
      expect(await repo().get(a, c.id)).toEqual(escalated);
      await expectRejectsWithName(repo().update(a, aCase(a)), 'NotFoundError');
    });

    it('lists by priority descending, then createdAt ascending, and filters', async () => {
      const { a } = freshClinics();
      const low = aCase(a, { priority: 10, createdAt: at(0) });
      const highOld = aCase(a, { priority: 90, createdAt: at(1), assignee: 'ana' });
      const highNew = aCase(a, { priority: 90, createdAt: at(2), origin: 'backfill' });
      const resolved = aCase(a, {
        priority: 99,
        status: 'resolved',
        resolution: { kind: 'not_needed', resolvedAt: at(3) },
      });
      const otherPatient = aCase(a, { priority: 50, patientId: patientId('pat-2') });
      await createAll(a, [low, highOld, highNew, resolved, otherPatient]);

      const active = await repo().list(a, { statuses: ['open'], limit: 10 });
      expect(active.items.map((c) => c.id)).toEqual([
        highOld.id,
        highNew.id,
        otherPatient.id,
        low.id,
      ]);
      expect(
        (await repo().list(a, { patientId: patientId('pat-2'), limit: 10 })).items.map((c) => c.id),
      ).toEqual([otherPatient.id]);
      expect((await repo().list(a, { assignee: 'ana', limit: 10 })).items.map((c) => c.id)).toEqual(
        [highOld.id],
      );
      expect(
        (await repo().list(a, { origin: 'backfill', limit: 10 })).items.map((c) => c.id),
      ).toEqual([highNew.id]);
      expect(
        (await repo().list(a, { statuses: ['resolved'], limit: 10 })).items.map((c) => c.id),
      ).toEqual([resolved.id]);
    });

    it('hides cases not yet released when releasedAsOf is set', async () => {
      const { a } = freshClinics();
      const visible = aCase(a, { origin: 'backfill', releaseAt: at(1) });
      const pending = aCase(a, { origin: 'backfill', releaseAt: at(10) });
      const live = aCase(a);
      await createAll(a, [visible, pending, live]);
      const page = await repo().list(a, { releasedAsOf: at(5), limit: 10 });
      expect(new Set(page.items.map((c) => c.id))).toEqual(new Set([visible.id, live.id]));
      const unreleased = await repo().list(a, { unreleasedAsOf: at(5), limit: 10 });
      expect(unreleased.items.map((c) => c.id)).toEqual([pending.id]);
    });

    it('pages through every case exactly once with the cursor', async () => {
      const { a } = freshClinics();
      const cases = Array.from({ length: 7 }, (_, index) =>
        aCase(a, { priority: index % 3, createdAt: at(index) }),
      );
      await createAll(a, cases);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await repo().list(a, { limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...result.items.map((c) => c.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(cases.map((c) => c.id)));
    });

    it('groups matching cases by patient: one item per patient, most urgent patient first (HIP-141)', async () => {
      const { a, b } = freshClinics();
      const ana = patientId('pat-q-ana');
      const bruno = patientId('pat-q-bruno');
      const carla = patientId('pat-q-carla');
      const anaPlan = aCase(a, { patientId: ana, priority: 60, createdAt: at(2) });
      const anaLabs = aCase(a, { patientId: ana, priority: 85, createdAt: at(3), assignee: 'u-1' });
      const brunoOnly = aCase(a, { patientId: bruno, priority: 85, createdAt: at(1) });
      const carlaOld = aCase(a, { patientId: carla, priority: 40, createdAt: at(0) });
      const carlaClosed = aCase(a, {
        patientId: carla,
        priority: 99,
        status: 'resolved',
        resolution: { kind: 'fulfilled', resolvedAt: at(4) },
      });
      await createAll(a, [anaPlan, anaLabs, brunoOnly, carlaOld, carlaClosed]);
      await repo().create(b, aCase(b, { patientId: ana, priority: 99 }));

      const page = await repo().listPatients(a, { statuses: ['open'], limit: 10 });
      // Ana and Bruno tie on their top priority (85): Ana's oldest case is older.
      expect(page.items.map((item) => item.patientId)).toEqual([bruno, ana, carla]);
      expect(page.items[1]?.cases.map((c) => c.id)).toEqual([anaLabs.id, anaPlan.id]);
      expect(page.nextCursor).toBeUndefined();

      // Filters select cases; a patient appears with the cases that match.
      const owned = await repo().listPatients(a, {
        statuses: ['open'],
        assignee: 'u-1',
        limit: 10,
      });
      expect(owned.items).toEqual([{ patientId: ana, cases: [anaLabs] }]);
      const named = await repo().listPatients(a, { patientIds: [carla, bruno], limit: 10 });
      expect(named.items.map((item) => item.patientId)).toEqual([carla, bruno]);
      expect(named.items[0]?.cases.map((c) => c.id)).toEqual([carlaClosed.id, carlaOld.id]);
      expect((await repo().listPatients(a, { patientIds: [], limit: 10 })).items).toEqual([]);

      const byAge = await repo().listPatients(a, {
        statuses: ['open'],
        orderBy: 'created_at',
        limit: 10,
      });
      expect(byAge.items.map((item) => item.patientId)).toEqual([carla, bruno, ana]);
      expect(byAge.items[2]?.cases.map((c) => c.id)).toEqual([anaPlan.id, anaLabs.id]);

      expect(await repo().count(a, { statuses: ['open'] })).toEqual({ patients: 3, cases: 4 });
      expect(await repo().count(a, {})).toEqual({ patients: 3, cases: 5 });
      expect(await repo().count(b, { statuses: ['open'] })).toEqual({ patients: 1, cases: 1 });
      expect(await repo().count(a, { patientIds: [] })).toEqual({ patients: 0, cases: 0 });
    });

    it('pages the patient queue without splitting a patient, every patient exactly once', async () => {
      const { a } = freshClinics();
      const cases = Array.from({ length: 11 }, (_, index) =>
        aCase(a, {
          patientId: patientId(`pat-page-${String(index % 5)}`),
          priority: (index * 7) % 4,
          createdAt: at(index),
        }),
      );
      await createAll(a, cases);
      const seen: string[] = [];
      let caseCount = 0;
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await repo().listPatients(a, { limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...result.items.map((item) => item.patientId));
        caseCount += result.items.reduce((sum, item) => sum + item.cases.length, 0);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(caseCount).toBe(11);
      await expectRejectsWithName(
        repo().listPatients(a, { limit: 2, cursor: 'not-a-cursor' }),
        'InvalidCursorError',
      );
    });

    it('hides unreleased cases from the patient queue when releasedAsOf is set', async () => {
      const { a } = freshClinics();
      const held = aCase(a, { patientId: patientId('pat-held'), releaseAt: at(10) });
      const shown = aCase(a, { patientId: patientId('pat-shown'), releaseAt: at(1) });
      await createAll(a, [held, shown]);
      const page = await repo().listPatients(a, { releasedAsOf: at(5), limit: 10 });
      expect(page.items.map((item) => item.patientId)).toEqual([shown.patientId]);
      expect(await repo().count(a, { unreleasedAsOf: at(5) })).toEqual({ patients: 1, cases: 1 });
    });

    it('finds cases due for action by the relevant instant, active only, with a limit', async () => {
      const { a } = freshClinics();
      const action3 = aCase(a, { nextActionAt: at(3) });
      const snoozed1 = aCase(a, { status: 'snoozed', snoozedUntil: at(1) });
      const action2 = aCase(a, { status: 'notified', nextActionAt: at(2) });
      const future = aCase(a, { nextActionAt: at(30) });
      const snoozedFuture = aCase(a, { status: 'snoozed', snoozedUntil: at(30) });
      const closed = aCase(a, { status: 'dismissed', nextActionAt: at(1) });
      await createAll(a, [action3, snoozed1, action2, future, snoozedFuture, closed]);

      const due = await repo().findDueForAction(a, at(5), 10);
      expect(due.map((c) => c.id)).toEqual([snoozed1.id, action2.id, action3.id]);
      expect((await repo().findDueForAction(a, at(5), 2)).map((c) => c.id)).toEqual([
        snoozed1.id,
        action2.id,
      ]);
    });

    it('rejects a case of another clinic with TenantMismatchError', async () => {
      const { a, b } = freshClinics();
      await expectRejectsWithName(repo().create(a, aCase(b)), 'TenantMismatchError');
      const stored = aCase(a);
      await repo().create(a, stored);
      await expectRejectsWithName(repo().update(b, stored), 'TenantMismatchError');
    });

    it('isolates clinics: nothing of clinic A is visible or writable from clinic B', async () => {
      const { a, b } = freshClinics();
      const c = aCase(a, { dedupKey: 'pat-1:shared', nextActionAt: at(1) });
      await repo().create(a, c);

      expect(await repo().get(b, c.id)).toBeUndefined();
      expect(await repo().findActiveByDedupKey(b, 'pat-1:shared')).toBeUndefined();
      expect((await repo().list(b, { limit: 100 })).items).toEqual([]);
      expect(await repo().findDueForAction(b, at(100), 100)).toEqual([]);
      await expectRejectsWithName(repo().update(b, { ...c, clinicId: b }), 'NotFoundError');

      // The same dedup key is independent per clinic.
      await repo().create(b, aCase(b, { dedupKey: 'pat-1:shared' }));
      expect(await repo().get(a, c.id)).toEqual(c);
    });
  });
}
