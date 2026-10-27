import type { PlanItem } from '../domain/clinical-event.ts';
import type { ClinicId } from '../domain/ids.ts';
import type { Coding } from '../domain/resource.ts';

/** What the extractor reads: one clinical note, without tenant or patient identifiers. */
export interface NoteExtractionInput {
  readonly documentId: string;
  readonly text: string;
  readonly specialty?: string;
  readonly authoredAt: Date;
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
