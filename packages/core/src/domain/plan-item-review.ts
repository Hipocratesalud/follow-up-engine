import type { PlanItemKind } from './clinical-event.ts';
import type { CaseId, ClinicId, ExpectationId, PatientId } from './ids.ts';

/**
 * A clinician's verdict on a plan item the AI read from a note (a
 * `doctor_plan` expectation), HIP-141:
 *
 * - `plan_item_confirmed`: the reading is right; the expectation records
 *   `confirmedBy`.
 * - `plan_item_corrected`: the date or the kind was wrong; the expectation
 *   is superseded (`corrected_by_clinician`) by a corrected one that keeps
 *   its evidence.
 * - `plan_item_rejected`: the note never asked for it; the expectation is
 *   cancelled (`rejected_by_clinician`) and a case left without reasons
 *   resolves.
 *
 * The same names are the case audit event types when the item belongs to a
 * case, so a case's history and the extraction metrics count the same thing.
 */
export const PLAN_ITEM_REVIEW_TYPES = [
  'plan_item_confirmed',
  'plan_item_corrected',
  'plan_item_rejected',
] as const;
export type PlanItemReviewType = (typeof PLAN_ITEM_REVIEW_TYPES)[number];

/** `closedReason` of a plan item a clinician corrected (superseded by the correction). */
export const CORRECTED_BY_CLINICIAN = 'corrected_by_clinician';
/** `closedReason` of a plan item a clinician rejected (cancelled). */
export const REJECTED_BY_CLINICIAN = 'rejected_by_clinician';

/** What a plan item asks for: the part a clinician can correct. */
export interface PlanItemReading {
  readonly kind: PlanItemKind;
  readonly dueAt: Date;
}

/**
 * Append-only audit record of a plan item review: who, when, what the AI
 * read and, for a correction, what the clinician changed it to. Ground
 * truth for the extraction metrics (confirmed, corrected, rejected rates).
 * Ids, codes and dates only: no note text.
 */
export interface PlanItemReview {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** The reviewed expectation (the one the AI read). */
  readonly expectationId: ExpectationId;
  readonly type: PlanItemReviewType;
  /** Host user id of the clinician. */
  readonly userId: string;
  readonly at: Date;
  /** The case the item belonged to when it was reviewed. */
  readonly caseId?: CaseId;
  /** What the AI read. */
  readonly before: PlanItemReading;
  /** `plan_item_corrected` only: what the clinician set. */
  readonly after?: PlanItemReading;
  /** `plan_item_corrected` only: the expectation that replaced the reviewed one. */
  readonly replacementId?: ExpectationId;
}
