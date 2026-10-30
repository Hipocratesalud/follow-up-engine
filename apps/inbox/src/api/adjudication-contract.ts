/*
 * The adjudicator's contract (PRD V2), mirroring
 * apps/api/src/http/adjudication-schemas.ts: decisions on ambiguous plan
 * items and the doctor's override.
 */

export const ADJUDICATION_DECISIONS = ['open', 'discard', 'needs_human'] as const;
export type AdjudicationDecision = (typeof ADJUDICATION_DECISIONS)[number];

export const ADJUDICATION_REASON_CODES = [
  'explicit_instruction',
  'timing_explicit',
  'timing_vague',
  'conditional_plan',
  'hypothetical_mention',
  'already_done',
  'negated',
  'patient_declined',
  'deferred_to_other_provider',
  'contradictory_signals',
  'insufficient_context',
  'no_verifiable_quote',
  'low_probability',
] as const;
export type AdjudicationReasonCode = (typeof ADJUDICATION_REASON_CODES)[number];

export type AdjudicationOverrideDecision = Exclude<AdjudicationDecision, 'needs_human'>;

export interface AdjudicationView {
  id: string;
  expectationId: string;
  patientId: string;
  caseId?: string;
  /** What the engine applies: the model's answer after the engine's checks. */
  decision: AdjudicationDecision;
  decisionLabel: string;
  modelDecision: AdjudicationDecision;
  /** Calibrated probability, 0 to 1, that the note really asks for the follow-up. */
  probability: number;
  reasons: { code: AdjudicationReasonCode; label: string }[];
  /** The model's rationale, in the response language. */
  rationale: string;
  /** Verbatim from the note (checked by the engine). */
  quotes: { quote: string; sourceDocumentId: string }[];
  inputConfidence: number;
  /** `shadow`: recorded only, nothing changed. */
  mode: 'shadow' | 'active';
  applied: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  costUsd: number;
  createdAt: string;
  override?: {
    decision: AdjudicationOverrideDecision;
    decisionLabel: string;
    by: string;
    at: string;
    note?: string;
  };
}

export interface AdjudicationList {
  items: AdjudicationView[];
  settings: { mode: 'off' | 'shadow' | 'active'; minConfidence: number; maxConfidence: number };
}

export interface AdjudicationListQuery {
  caseId?: string;
  patientId?: string;
}

export interface AdjudicationOverrideRequest {
  decision: AdjudicationOverrideDecision;
  note?: string;
}

export interface AdjudicationOverrideResponse {
  adjudication: AdjudicationView;
  casesResolved: string[];
}
