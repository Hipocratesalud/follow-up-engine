import type { PlanItem } from '../domain/clinical-event.ts';
import type { ClinicId } from '../domain/ids.ts';
import type { Coding } from '../domain/resource.ts';

/** What the extractor reads: one clinical note, without tenant or patient identifiers. */
export interface NoteExtractionInput {
  readonly documentId: string;
  readonly text: string;
  readonly specialty?: string;
  readonly authoredAt: Date;
  /**
   * The patient's names and identifiers, for the extractor to mask before the
   * note leaves for a model (never sent). Filled by the composition root from
   * the Patient resource the host sent; the engine itself passes none.
   */
  readonly redactTerms?: readonly string[];
}

/** A condition the model read from the note. */
export interface ExtractedCondition {
  /** ICD-10, system `http://hl7.org/fhir/sid/icd-10`. */
  readonly code: Coding;
  /** 0 to 1. */
  readonly confidence: number;
  /** Verbatim substring of the note. */
  readonly evidenceQuote: string;
}

/** A medication the model read from the note. */
export interface ExtractedMedication {
  readonly text: string;
  readonly code?: Coding;
  readonly durationDays?: number;
  readonly evidenceQuote: string;
}

/** Structured reading of one note: the doctor's plan plus conditions and medications. */
export interface NoteExtraction {
  readonly hasPlan: boolean;
  readonly conditions: readonly ExtractedCondition[];
  readonly medications: readonly ExtractedMedication[];
  /** `dueAt` already resolved against `authoredAt`. */
  readonly planItems: readonly PlanItem[];
  /**
   * The note ends follow-up in this specialty ("se da de alta"): the visit
   * pattern stops here. Optional; absent means no.
   */
  readonly discharged?: boolean;
  /**
   * The note was longer than the extractor reads: its head and its tail were
   * read, the middle was not, so the plan may be incomplete. The engine
   * records a `note_truncated` quality finding for the clinician. Optional;
   * absent means the whole note was read.
   */
  readonly truncated?: boolean;
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
}

/**
 * Reads the doctor's plan out of a free-text note (implemented by
 * `@follow-up-engine/llm` through the `llm_gateway`). `clinicId` is for
 * accounting only and never reaches the model. Throws when the note cannot
 * be read; the engine then stores a retryable job instead of failing ingest.
 */
export interface NoteExtractor {
  extract(clinicId: ClinicId, input: NoteExtractionInput): Promise<NoteExtraction>;
}
