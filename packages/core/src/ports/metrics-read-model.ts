import type { CaseEvent, CaseFeedback, FollowUpCase } from '../domain/case.ts';
import type { PatientCondition } from '../domain/condition.ts';
import type { Expectation } from '../domain/expectation.ts';
import type { CaseId, ClinicId, ExpectationId } from '../domain/ids.ts';

/** A half-open interval of time, `[from, to)`. */
export interface MetricsPeriod {
  readonly from: Date;
  readonly to: Date;
}

/** What one note's reading cost (`plan.extracted`, every version of the note summed). */
export interface NoteExtractionCost {
  readonly documentId: string;
  readonly costUsd: number;
}

/** LLM usage of one gateway task over a period (`note_extraction`, `clinical_review`, ...). */
export interface LlmTaskUsage {
  readonly task: string;
  /** Provider calls, retries and failures included. */
  readonly calls: number;
  readonly successfulCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Clinical review runs started in a period and what they cost. */
export interface ReviewRunTotals {
  readonly runs: number;
  readonly costUsd: number;
}

/**
 * A clinician's correction of something the engine read from a note, other
 * than a condition: confirming, correcting or rejecting a plan item. Read
 * from the case trail (`case_events`) by type, so the metrics count them as
 * soon as a feature records them ({@link PLAN_ITEM_REVIEW_EVENT_TYPES}).
 */
export interface PlanItemReview {
  readonly type: string;
  readonly at: Date;
}

/** Case event types that record a clinician's review of an extracted plan item. */
export const PLAN_ITEM_REVIEW_EVENT_TYPES = [
  'plan_item_confirmed',
  'plan_item_corrected',
  'plan_item_rejected',
] as const;
export type PlanItemReviewType = (typeof PLAN_ITEM_REVIEW_EVENT_TYPES)[number];

/**
 * Read side of the clinic metrics (HIP-141): the few queries the pure
 * metrics computation (`engine/metrics`) needs, each scoped to one clinic.
 * Bound to a transaction like every store, so the Postgres adapter reads
 * under the clinic's row-level security. Never writes.
 */
export interface MetricsReadModel {
  /**
   * Cases that reached the inbox in the period: opened (`createdAt`) there,
   * or, for a held backfill case, released (`releaseAt`) there. Any status.
   */
  casesOpened(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly FollowUpCase[]>;

  /** The trail of the given cases, chronological per case (`at`, then insertion). */
  caseEvents(clinicId: ClinicId, caseIds: readonly CaseId[]): Promise<readonly CaseEvent[]>;

  /** Every verdict on the given cases, oldest first. */
  feedbackForCases(
    clinicId: ClinicId,
    caseIds: readonly CaseId[],
  ): Promise<readonly CaseFeedback[]>;

  expectations(clinicId: ClinicId, ids: readonly ExpectationId[]): Promise<readonly Expectation[]>;

  /** What reading each of the given notes cost; notes never read are absent. */
  noteExtractionCosts(
    clinicId: ClinicId,
    documentIds: readonly string[],
  ): Promise<readonly NoteExtractionCost[]>;

  /**
   * Conditions the engine inferred or read from a note (every source but a
   * coded diagnosis, `recorded`), reviewed or not.
   */
  engineConditions(clinicId: ClinicId): Promise<readonly PatientCondition[]>;

  /** Plan-item reviews recorded in the period, oldest first. */
  planItemReviews(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly PlanItemReview[]>;

  /** LLM calls in the period by task, task ascending. */
  llmUsageByTask(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly LlmTaskUsage[]>;

  /** Clinical review runs started in the period. */
  reviewRuns(clinicId: ClinicId, period: MetricsPeriod): Promise<ReviewRunTotals>;
}
