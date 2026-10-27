import {
  caseId,
  type ClinicId,
  expectationId,
  patientId,
  type PlanItemReview,
  type PlanItemReviewLog,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

/** A plan item review; a correction when `after` is given. */
export function aPlanItemReview(
  clinic: ClinicId,
  overrides: Partial<PlanItemReview> = {},
): PlanItemReview {
  return {
    id: uniqueId('pir'),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    expectationId: expectationId('exp-plan-1'),
    type: 'plan_item_confirmed',
    userId: 'dra-mora',
    at: at(1),
    before: { kind: 'follow_up_visit', dueAt: at(90) },
    ...overrides,
  };
}

/** Contract every {@link PlanItemReviewLog} adapter must pass (HIP-141). */
export function describePlanItemReviewLogContract(
  name: string,
  makeSubject: MakeSubject<PlanItemReviewLog>,
): void {
  describe(`PlanItemReviewLog contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const log = () => current().subject;

    it('appends reviews and reads them back per expectation, per patient and by time', async () => {
      const { a } = freshClinics();
      const item = expectationId(uniqueId('exp'));
      const patient = patientId(uniqueId('pat'));
      const confirmed = aPlanItemReview(a, { expectationId: item, patientId: patient, at: at(1) });
      const corrected = aPlanItemReview(a, {
        expectationId: item,
        patientId: patient,
        type: 'plan_item_corrected',
        at: at(3),
        caseId: caseId('case-1'),
        after: { kind: 'lab', dueAt: at(30) },
        replacementId: expectationId('exp-corrected'),
      });
      const rejected = aPlanItemReview(a, {
        patientId: patient,
        type: 'plan_item_rejected',
        at: at(2),
        before: { kind: 'imaging', dueAt: at(14) },
      });
      for (const review of [confirmed, corrected, rejected]) await log().append(a, review);
      expect(await log().listForExpectation(a, item)).toEqual([confirmed, corrected]);
      expect(await log().listByPatient(a, patient)).toEqual([confirmed, rejected, corrected]);
      const since = await log().listSince(a, at(2), 10);
      expect(since).toEqual([rejected, corrected]);
      expect(await log().listSince(a, at(0), 1)).toEqual([confirmed]);
    });

    it('keeps append order on the same instant', async () => {
      const { a } = freshClinics();
      const item = expectationId(uniqueId('exp'));
      const first = aPlanItemReview(a, { expectationId: item, at: at(5) });
      const second = aPlanItemReview(a, {
        expectationId: item,
        at: at(5),
        type: 'plan_item_rejected',
      });
      await log().append(a, first);
      await log().append(a, second);
      expect(await log().listForExpectation(a, item)).toEqual([first, second]);
    });

    it('rejects a duplicate id and another clinic’s entry; isolates clinics', async () => {
      const { a, b } = freshClinics();
      const review = aPlanItemReview(a);
      await log().append(a, review);
      await expectRejectsWithName(log().append(a, review), 'ConflictError');
      await expectRejectsWithName(log().append(a, aPlanItemReview(b)), 'TenantMismatchError');
      expect(await log().listForExpectation(b, review.expectationId)).toEqual([]);
      expect(await log().listSince(b, at(0), 10)).toEqual([]);
    });
  });
}
