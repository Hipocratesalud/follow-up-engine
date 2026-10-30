import type { AdjudicationDecision, AdjudicationReasonCode } from '../domain/adjudication.ts';
import type { PlanItemKind } from '../domain/clinical-event.ts';
import type { ClinicId } from '../domain/ids.ts';

/**
 * The adjudicator's port (PRD V2 `DecisionProvider`): a decision model that
 * reads one ambiguous plan item with its note and returns a typed decision.
 * Implemented in `@follow-up-engine/llm` on the `llm_gateway` (Muse Spark, or
 * a deterministic scripted adjudicator in CI and the key-less demo).
 * Everything it returns is untrusted: the engine checks every quote verbatim
 * against the note and turns an answer it cannot back into `needs_human`.
 */

/**
 * What the model sees: structured signals computed by code and the note.
 * Pseudonymous: no clinic, patient, case or expectation id, no name, phone
 * or document number (the note is masked with `redactTerms` before it
 * leaves). Dates and intervals are computed by code, never by the model.
 */
export interface AdjudicationInput {
  /** A per-call pseudonym (`ITEM-xxxxxxxx`). */
  readonly itemRef: string;
  /** What the extractor read the item asks for. */
  readonly kind: PlanItemKind;
  /** The extractor's short English description, when the note's plan event has it. */
  readonly description?: string;
  /** The extractor's quote for the item, verbatim from the note. */
  readonly evidenceQuote: string;
  /** The extractor's confidence (why the item is ambiguous). */
  readonly extractionConfidence: number;
  /** Day the note was written (`YYYY-MM-DD`). */
  readonly noteDate: string;
  /** Days from the note to the item's due date, computed by code. */
  readonly dueInDays: number;
  readonly specialty?: string;
  /** The other items read from the same note, for context. */
  readonly otherPlanItems: readonly {
    readonly kind: PlanItemKind;
    readonly description: string;
  }[];
  /** The note, unmasked: the adapter masks `redactTerms` before anything leaves. */
  readonly noteText: string;
}

export interface AdjudicationRequest {
  readonly input: AdjudicationInput;
  /** The patient's names and identifiers: masked in everything sent to the model. */
  readonly redactTerms: readonly string[];
}

/** The model's answer, typed and schema-checked, before the engine's own checks. */
export interface AdjudicationProviderResult {
  readonly decision: AdjudicationDecision;
  /** Probability that the follow-up is real, calibrated by the adapter (0 to 1). */
  readonly probability: number;
  readonly reasonCodes: readonly AdjudicationReasonCode[];
  /** One or two sentences for the clinician, in English and in Spanish. */
  readonly rationale: { readonly en: string; readonly es: string };
  /** Quotes as the original (unmasked) note has them, when the adapter could map them back. */
  readonly quotes: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

/**
 * Throws `LlmBudgetExceededError` when the clinic's budget is spent and any
 * error the gateway gives up on; the job then retries later, and the item
 * keeps being followed up as it is meanwhile (never blocks).
 */
export interface ExpectationAdjudicator {
  decide(clinicId: ClinicId, request: AdjudicationRequest): Promise<AdjudicationProviderResult>;
}
