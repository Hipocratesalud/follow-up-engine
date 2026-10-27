import type { ClinicId, Coding, PlanItem } from '@follow-up-engine/core';

/*
 * Structural copies of the `NoteExtractor` port from
 * `packages/core/src/ports/note-extractor.ts` (added to core in parallel,
 * same shape). Replace with `import type` from core once it is merged.
 */

export interface NoteExtractionInput {
  readonly documentId: string;
  readonly text: string;
  readonly specialty?: string;
  readonly authoredAt: Date;
  /**
   * Names and identifiers of the patient (from the Patient resource of the
   * same Bundle) to mask before the note leaves for a model. Never sent.
   */
  readonly redactTerms?: readonly string[];
}

export interface ExtractedCondition {
  /** ICD-10, system `http://hl7.org/fhir/sid/icd-10`. */
  readonly code: Coding;
  /** 0 to 1. */
  readonly confidence: number;
  /** Verbatim substring of the note. */
  readonly evidenceQuote: string;
}

export interface ExtractedMedication {
  readonly text: string;
  readonly code?: Coding;
  readonly durationDays?: number;
  readonly evidenceQuote: string;
}

export interface NoteExtraction {
  readonly hasPlan: boolean;
  readonly conditions: readonly ExtractedCondition[];
  readonly medications: readonly ExtractedMedication[];
  /** `dueAt` already resolved against `authoredAt`. */
  readonly planItems: readonly PlanItem[];
  /** The note ends follow-up in this specialty ("se da de alta"). Absent means no. */
  readonly discharged?: boolean;
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
}

export interface NoteExtractor {
  extract(clinicId: ClinicId, input: NoteExtractionInput): Promise<NoteExtraction>;
}

/** Why a model item was dropped by the deterministic post-checks. */
export type RejectionReason =
  /** The quote is not in the note. */
  | 'quote_not_found'
  /** The quote is in the note but too short to back anything ("a", ".", "Plan"). */
  | 'quote_too_short'
  /** The quote does not support the item (no term linked to the ICD-10 code, no drug name, no plan wording). */
  | 'quote_unrelated'
  /** The note denies the condition ("niega HTA", "Diabetes: no", "sin DM ni HTA"). */
  | 'negated'
  /** The condition is a relative's ("madre con DM2", "AHF: HTA (padre)"). */
  | 'family_history'
  /**
   * Not a current condition of the patient: a risk ("riesgo de diabetes"),
   * gestational diabetes or prediabetes read as diabetes, a past pregnancy
   * read as a current one.
   */
  | 'not_current'
  /** A conditional or as-needed return ("volver si presenta fiebre"), not scheduled follow-up. */
  | 'conditional'
  /** The model's interval disagrees with the interval stated where it quotes. */
  | 'timing_mismatch'
  /**
   * The model's explicit date is not written in the note, nor follows from
   * the interval written where it quotes ("Control en 3 meses" due in 2031).
   */
  | 'timing_unsupported'
  /**
   * The quote does not name what the model said: a lab or imaging item whose
   * quote has no test wording, an `other` item whose quote names no referral
   * or procedure. The item is kept as a generic follow-up visit, without code.
   */
  | 'test_not_named'
  /** A measurement reported as a medication ("Hemoglobina 10,8 g/dL"). */
  | 'not_a_medication'
  | 'invalid_code'
  | 'no_due_date'
  | 'due_before_note'
  | 'empty_text'
  | 'duplicate';

export interface RejectedItem {
  readonly field: 'condition' | 'medication' | 'planItem' | 'discharge';
  readonly reason: RejectionReason;
  readonly evidenceQuote: string;
}

/**
 * {@link NoteExtraction} plus the accounting and diagnostics the eval
 * harness and the demo endpoint show. Still assignable to the port type.
 */
export interface DetailedNoteExtraction extends NoteExtraction {
  readonly provider: string;
  readonly callId: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Items the model returned, before post-checks. */
  readonly modelItemCount: number;
  /** Items dropped by post-checks, with the reason. */
  readonly rejected: readonly RejectedItem[];
  /** Verbatim note text that discharges the patient, when `discharged`. */
  readonly dischargeEvidenceQuote?: string;
  /**
   * What the extractor did to the note before sending it, for the engine and
   * the API to show next to the extraction: `note_truncated` (longer than
   * the cap: its head and its tail were read, the middle was not),
   * `names_masked` (patient names or identifiers replaced),
   * `tags_neutralized` (delimiter-shaped tags).
   */
  readonly warnings: readonly ExtractionWarning[];
}

export type ExtractionWarning = 'note_truncated' | 'names_masked' | 'tags_neutralized';
