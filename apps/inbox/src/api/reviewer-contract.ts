/**
 * Clinical reviewer HTTP contract (`/api/inbox/findings`, `/api/inbox/finding-flags`).
 * Mirrors `apps/api/src/http/reviewer-schemas.ts` on purpose: the inbox only talks HTTP.
 */

export const FINDING_CATEGORIES = [
  'pre_visit_question',
  'lab_trend',
  'vital_trend',
  'abnormal_result_no_followup',
  'drug_interaction',
  'drug_condition_conflict',
  'unaddressed_symptom',
  'missing_screening',
  'record_quality',
  'utilization_change',
  'similar_patients',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type FindingMode = 'shadow' | 'live';
export const FINDING_VERDICTS = ['relevant', 'already_known', 'not_relevant'] as const;
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];
export type FindingStatus = 'open' | FindingVerdict | 'expired';
export type CitationKind = 'note' | 'result' | 'medication' | 'condition';

export interface FindingCitation {
  /** The cited resource, `ResourceType/id`. */
  docId: string;
  kind: CitationKind;
  /** Verbatim text of the document. */
  quote: string;
  date: string;
  title: string;
  specialty?: string;
  /** Full text of a cited note (the quote is highlighted inside it). */
  text?: string;
}

export interface TrendPoint {
  docId: string;
  date: string;
  value: number;
  cited: boolean;
}

export interface FindingTrend {
  test: string;
  label: string;
  unit: string;
  low?: number;
  high?: number;
  points: TrendPoint[];
}

export interface FindingCoverageView {
  kind: 'expectation' | 'case';
  id: string;
  code: string;
  label: string;
}

export interface FindingReviewView {
  verdict: FindingVerdict;
  reason?: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface FindingView {
  id: string;
  patient: {
    id: string;
    name: string;
    age?: number;
    sex?: 'female' | 'male' | 'other' | 'unknown';
  };
  category: FindingCategory;
  categoryLabel: string;
  severity: FindingSeverity;
  mode: FindingMode;
  status: FindingStatus;
  summary: string;
  rationale: string;
  suggestion: string;
  alreadyCovered: boolean;
  coveredBy: FindingCoverageView[];
  citations: FindingCitation[];
  trend?: FindingTrend;
  specialty?: string;
  origin: 'confirmed' | 'added' | 'fallback';
  modelId: string;
  promptVersion: string;
  runId: string;
  createdAt: string;
  review?: FindingReviewView;
}

export interface ReviewStepView {
  index: number;
  tool: string;
  arguments: Record<string, unknown>;
  outcome: string;
  summary: string;
}

export interface ReviewRunView {
  id: string;
  trigger: string;
  status: 'completed' | 'degraded' | 'skipped' | 'failed';
  stopReason: string;
  signalsCount: number;
  findingsCount: number;
  discardedCount: number;
  duplicateCount: number;
  discarded: { reason: string; count: number }[];
  steps: number;
  toolCalls: number;
  trace: ReviewStepView[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelId: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
}

export interface FindingDetail extends FindingView {
  run?: ReviewRunView;
}

export interface FindingCounts {
  total: number;
  byStatus: Partial<Record<FindingStatus, number>>;
  byCategory: Partial<Record<FindingCategory, number>>;
  bySeverity: Partial<Record<FindingSeverity, number>>;
}

export interface FindingPage {
  items: FindingView[];
  nextCursor?: string;
  counts: FindingCounts;
}

export interface FindingListQuery {
  mode?: FindingMode;
  /** `reviewed`: any verdict. */
  status?: FindingStatus | 'reviewed';
  /** Comma-separated categories. */
  category?: string;
  /** Comma-separated severities. */
  severity?: string;
  patientId?: string;
  limit?: number;
  cursor?: string;
}

export interface FindingReviewRequest {
  verdict: FindingVerdict;
  reason?: string;
}

export interface FindingFlagView {
  category: FindingCategory;
  label: string;
  description: string;
  implemented: boolean;
  specialty?: string;
  enabled: boolean;
  mode: FindingMode;
  validatedBy?: string;
  validatedAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  review: {
    reviewed: number;
    relevant: number;
    alreadyKnown: number;
    notRelevant: number;
    /** relevant / reviewed, 0..1. */
    precision?: number;
  };
}

export interface FindingFlagUpdate {
  category: FindingCategory;
  specialty?: string | null;
  enabled: boolean;
  mode: FindingMode;
  validatedBy?: string;
}

export interface ReviewMetrics {
  since: string;
  runs: number;
  patientsReviewed: number;
  findings: number;
  findingsPer100Patients: number;
  discarded: number;
  duplicates: number;
  degraded: number;
  avgToolCalls: number;
  avgCostUsd: number;
  costUsd: number;
  reviewed: number;
  relevant: number;
  alreadyKnown: number;
  precision?: number;
}
