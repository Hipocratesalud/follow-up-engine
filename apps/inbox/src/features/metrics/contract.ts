/**
 * `GET /api/inbox/metrics` (HIP-141): the clinic metrics, FHIR-free. Mirrors
 * `apps/api/src/metrics/schemas.ts`; every number is defined in
 * docs/metrics.md.
 */

export interface OriginSplit {
  total: number;
  followUpCase: number;
  patientContact: number;
  organic: number;
}

export const ORIGIN_KEYS = ['followUpCase', 'patientContact', 'organic'] as const;
export type OriginKey = (typeof ORIGIN_KEYS)[number];

export const METRICS_DISMISS_REASONS = [
  'handled_elsewhere',
  'already_done',
  'not_applicable_to_patient',
  'wrong_diagnosis',
  'wrong_interval',
  'other',
] as const;
export type MetricsDismissReason = (typeof METRICS_DISMISS_REASONS)[number];

export interface LlmTaskUsage {
  task: string;
  calls: number;
  successfulCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ClinicMetricsView {
  period: { from: string; to: string };
  asOf: string;
  cases: {
    opened: number;
    live: number;
    backfill: number;
    active: number;
    resolved: number;
    dismissed: number;
    lostToFollowUp: number;
  };
  bookings: {
    booked: OriginSplit;
    attended: OriginSplit;
    resolvedByBooking: OriginSplit;
    bookedRate?: number;
    attendedRate?: number;
    attributedShare?: number;
  };
  timeToFirstAction: {
    measured: number;
    pending: number;
    medianHours?: number;
    p75Hours?: number;
    p90Hours?: number;
  };
  feedback: {
    casesWithFeedback: number;
    useful: number;
    notUseful: number;
    usefulRate?: number;
    notUsefulReasons: Record<string, number>;
  };
  dismissals: { total: number; byReason: Record<MetricsDismissReason, number> };
  extractionReviews: {
    conditions: {
      reviewed: number;
      confirmed: number;
      rejected: number;
      pendingReview: number;
      confirmRate?: number;
      rejectRate?: number;
    };
    planItems: {
      total: number;
      confirmed: number;
      corrected: number;
      rejected: number;
      correctionRate?: number;
    };
  };
  aiCost: {
    totalUsd: number;
    calls: number;
    byTask: LlmTaskUsage[];
    attributedToCasesUsd: number;
    casesWithAttributedCost: number;
    perCaseUsd?: number;
    allInPerCaseUsd?: number;
    reviewRuns: number;
    reviewerUsd: number;
    perReviewRunUsd?: number;
  };
  backfill: { cases: number; recoveredPatients: number; recoveredCases: number };
}

export interface MetricsQuery {
  /** ISO 8601; the API defaults to 30 days before `to`. */
  from?: string;
  /** ISO 8601, exclusive; the API defaults to now included. */
  to?: string;
}
