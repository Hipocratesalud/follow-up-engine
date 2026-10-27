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
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
}

export interface NoteExtractor {
  extract(clinicId: ClinicId, input: NoteExtractionInput): Promise<NoteExtraction>;
}

/** Why a model item was dropped by the deterministic post-checks. */
export type RejectionReason =
  | 'quote_not_found'
  | 'invalid_code'
  | 'no_due_date'
  | 'due_before_note'
  | 'empty_text'
  | 'duplicate';

export interface RejectedItem {
  readonly field: 'condition' | 'medication' | 'planItem';
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
}
