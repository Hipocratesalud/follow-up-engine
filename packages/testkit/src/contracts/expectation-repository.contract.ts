import { caseId, type ExpectationRepository, patientId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { anExpectation } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  useSubject,
} from './harness.ts';

/** Contract every {@link ExpectationRepository} adapter must pass. */
export function describeExpectationRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ExpectationRepository>,
): void {
  describe(`ExpectationRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('creates an expectation and reads it back', async () => {
      const { a } = freshClinics();
      const expectation = anExpectation(a);
      const result = await repo().upsertByIdempotencyKey(a, expectation);
      expect(result.created).toBe(true);
      expect(result.expectation).toEqual(expectation);
      expect(await repo().get(a, expectation.id)).toEqual(expectation);
    });

    it('is idempotent on idempotencyKey and leaves the stored one untouched', async () => {
      const { a } = freshClinics();
      const first = anExpectation(a);
      await repo().upsertByIdempotencyKey(a, first);
      const retry = anExpectation(a, { idempotencyKey: first.idempotencyKey, dueAt: at(99) });
      const result = await repo().upsertByIdempotencyKey(a, retry);
      expect(result.created).toBe(false);
      expect(result.expectation).toEqual(first);
      expect(await repo().get(a, retry.id)).toBeUndefined();
    });

    it('returns undefined for an unknown id', async () => {
      const { a } = freshClinics();
      expect(await repo().get(a, anExpectation(a).id)).toBeUndefined();
    });

    it('lists only open expectations of a patient, by dueAt ascending', async () => {
      const { a } = freshClinics();
      const patient = patientId('pat-open');
      const late = anExpectation(a, { patientId: patient, dueAt: at(30) });
      const early = anExpectation(a, { patientId: patient, dueAt: at(5) });
      const closed = anExpectation(a, { patientId: patient, dueAt: at(1), status: 'fulfilled' });
      const otherPatient = anExpectation(a, { dueAt: at(2) });
      for (const e of [late, early, closed, otherPatient])
        await repo().upsertByIdempotencyKey(a, e);
      const open = await repo().findOpenByPatient(a, patient);
      expect(open.map((e) => e.id)).toEqual([early.id, late.id]);
    });

    it('lists every expectation of a patient by dueAt, optionally by status', async () => {
      const { a } = freshClinics();
      const patient = patientId('pat-all');
      const open = anExpectation(a, { patientId: patient, dueAt: at(30) });
      const fulfilled = anExpectation(a, { patientId: patient, dueAt: at(5), status: 'fulfilled' });
      const expired = anExpectation(a, { patientId: patient, dueAt: at(10), status: 'expired' });
      const other = anExpectation(a, { dueAt: at(1) });
      for (const e of [open, fulfilled, expired, other]) await repo().upsertByIdempotencyKey(a, e);
      expect((await repo().listByPatient(a, patient)).map((e) => e.id)).toEqual([
        fulfilled.id,
        expired.id,
        open.id,
      ]);
      expect(
        (await repo().listByPatient(a, patient, ['open', 'expired'])).map((e) => e.id),
      ).toEqual([expired.id, open.id]);
    });

    it('round-trips every optional field', async () => {
      const { a } = freshClinics();
      const full = anExpectation(a, {
        layer: 'doctor_plan',
        status: 'expired',
        caseId: caseId('case-x'),
        closedReason: 'superseded_by_new_order',
        closedAt: at(3),
        closedBy: { resourceType: 'ServiceRequest', id: 'sr-2' },
        origin: 'backfill',
        protocolId: 'diabetes',
        protocolVersion: '1.0.0',
        evidence: { quote: 'ctrl en 3 meses', sourceDocumentId: 'doc-1' },
        recheckAt: at(12),
        severity: 'critical',
      });
      await repo().upsertByIdempotencyKey(a, full);
      expect(await repo().get(a, full.id)).toEqual(full);
    });

    it('finds fulfilled expectations to recheck by recheckAt, honouring the limit', async () => {
      const { a, b } = freshClinics();
      const fulfilled = { status: 'fulfilled' as const, closedReason: 'fulfilled_by_appointment' };
      const r9 = anExpectation(a, { ...fulfilled, recheckAt: at(9) });
      const r4 = anExpectation(a, { ...fulfilled, recheckAt: at(4) });
      const r10 = anExpectation(a, { ...fulfilled, recheckAt: at(10) });
      const later = anExpectation(a, { ...fulfilled, recheckAt: at(30) });
      const byVisit = anExpectation(a, { ...fulfilled, closedReason: 'fulfilled_by_encounter' });
      const open = anExpectation(a, { recheckAt: at(1) });
      for (const e of [r9, r4, r10, later, byVisit, open]) {
        await repo().upsertByIdempotencyKey(a, e);
      }
      expect((await repo().findDueForRecheck(a, at(10), 10)).map((e) => e.id)).toEqual([
        r4.id,
        r9.id,
        r10.id,
      ]);
      expect((await repo().findDueForRecheck(a, at(10), 1)).map((e) => e.id)).toEqual([r4.id]);
      expect(await repo().findDueForRecheck(b, at(100), 10)).toEqual([]);
    });

    it('finds due open expectations ordered by dueAt and honours the limit', async () => {
      const { a } = freshClinics();
      const d10 = anExpectation(a, { dueAt: at(10) });
      const d5 = anExpectation(a, { dueAt: at(5) });
      const d7 = anExpectation(a, { dueAt: at(7) });
      const future = anExpectation(a, { dueAt: at(40) });
      const expired = anExpectation(a, { dueAt: at(1), status: 'expired' });
      for (const e of [d10, d5, d7, future, expired]) await repo().upsertByIdempotencyKey(a, e);

      const due = await repo().findDue(a, at(10), 10);
      expect(due.map((e) => e.id)).toEqual([d5.id, d7.id, d10.id]);
      const limited = await repo().findDue(a, at(10), 2);
      expect(limited.map((e) => e.id)).toEqual([d5.id, d7.id]);
    });

    it('includes an expectation due exactly at now', async () => {
      const { a } = freshClinics();
      const e = anExpectation(a, { dueAt: at(15) });
      await repo().upsertByIdempotencyKey(a, e);
      expect((await repo().findDue(a, at(15), 10)).map((x) => x.id)).toEqual([e.id]);
    });

    it('updates a stored expectation', async () => {
      const { a } = freshClinics();
      const e = anExpectation(a);
      await repo().upsertByIdempotencyKey(a, e);
      const closed = {
        ...e,
        status: 'fulfilled' as const,
        closedReason: 'fulfilled_by_result',
        closedAt: at(3),
        updatedAt: at(3),
      };
      await repo().update(a, closed);
      expect(await repo().get(a, e.id)).toEqual(closed);
      expect(await repo().findDue(a, at(30), 10)).toEqual([]);
    });

    it('lets an expired expectation close late (fulfilled, superseded or cancelled)', async () => {
      const { a } = freshClinics();
      for (const status of ['fulfilled', 'superseded', 'cancelled'] as const) {
        const expired = anExpectation(a, { status: 'expired', caseId: caseId('case-late') });
        await repo().upsertByIdempotencyKey(a, expired);
        const closed = { ...expired, status, closedReason: `late_${status}`, closedAt: at(20) };
        await repo().update(a, closed);
        expect(await repo().get(a, expired.id)).toEqual(closed);
      }
    });

    it('rejects updating an unknown expectation with NotFoundError', async () => {
      const { a } = freshClinics();
      await expectRejectsWithName(repo().update(a, anExpectation(a)), 'NotFoundError');
    });

    it('rejects an expectation of another clinic with TenantMismatchError', async () => {
      const { a, b } = freshClinics();
      await expectRejectsWithName(
        repo().upsertByIdempotencyKey(a, anExpectation(b)),
        'TenantMismatchError',
      );
      const stored = anExpectation(a);
      await repo().upsertByIdempotencyKey(a, stored);
      await expectRejectsWithName(repo().update(b, stored), 'TenantMismatchError');
    });

    it('isolates clinics: nothing of clinic A is visible or writable from clinic B', async () => {
      const { a, b } = freshClinics();
      const e = anExpectation(a, { patientId: patientId('pat-shared'), dueAt: at(1) });
      await repo().upsertByIdempotencyKey(a, e);

      expect(await repo().get(b, e.id)).toBeUndefined();
      expect(await repo().findOpenByPatient(b, e.patientId)).toEqual([]);
      expect(await repo().listByPatient(b, e.patientId)).toEqual([]);
      expect(await repo().findDue(b, at(100), 100)).toEqual([]);
      await expectRejectsWithName(repo().update(b, { ...e, clinicId: b }), 'NotFoundError');

      // The same idempotency key is independent per clinic.
      const twin = anExpectation(b, { idempotencyKey: e.idempotencyKey });
      expect((await repo().upsertByIdempotencyKey(b, twin)).created).toBe(true);
      expect(await repo().get(a, e.id)).toEqual(e);
    });
  });
}
