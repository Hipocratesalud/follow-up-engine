import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';
import type { PlanItemReview } from '../domain/plan-item-review.ts';

/**
 * Append-only audit of clinicians' verdicts on AI-read plan items (HIP-141).
 * Unlike the case audit log, it covers items that never became a case (a
 * plan item confirmed while still open). Entries are never updated or deleted.
 */
export interface PlanItemReviewLog {
  /** Throws `TenantMismatchError` for another clinic's entry, `ConflictError` for a duplicate id. */
  append(clinicId: ClinicId, review: PlanItemReview): Promise<void>;

  /** The reviews of one expectation, oldest first. */
  listForExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<readonly PlanItemReview[]>;

  /** The reviews of a patient's plan items, oldest first. */
  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly PlanItemReview[]>;

  /** Reviews at or after `since`, oldest first (extraction metrics). */
  listSince(clinicId: ClinicId, since: Date, limit: number): Promise<readonly PlanItemReview[]>;
}
