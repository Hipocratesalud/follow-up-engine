import type { ClinicId, PatientId } from './ids.ts';

/**
 * Why an imported lab report was held instead of recorded:
 * `name_mismatch`, the name printed on it is not the patient's;
 * `photo_not_allowed`, it is a photo and the clinic does not send unmasked
 * images to a model provider (`allowUnmaskedImagesToProvider`), so nothing
 * was read: the team reads it and enters the result by hand;
 * `scan_not_allowed`, the same for a scanned PDF (no text layer: only its
 * pixels could be read, and pixels cannot be masked).
 */
export const HELD_LAB_REPORT_REASONS = [
  'name_mismatch',
  'photo_not_allowed',
  'scan_not_allowed',
] as const;

/** How a lab report was read: a photo (vision), a document's text, or a scanned PDF's pages (vision). */
export const LAB_REPORT_SOURCES = ['photo', 'text', 'scan'] as const;
export type LabReportSource = (typeof LAB_REPORT_SOURCES)[number];
export type HeldLabReportReason = (typeof HELD_LAB_REPORT_REASONS)[number];

export const HELD_LAB_REPORT_STATUSES = ['pending', 'confirmed', 'discarded'] as const;
export type HeldLabReportStatus = (typeof HELD_LAB_REPORT_STATUSES)[number];

/** One test a held report printed, coded like an accepted one (so a confirmation records it as is). */
export interface HeldLabResult {
  /** The test as printed (clinical content, in its own language). */
  readonly name: string;
  /** The engine's test group and its LOINC code. */
  readonly groupId: string;
  readonly test: string;
  readonly code: { readonly system: string; readonly code: string; readonly display: string };
  readonly value: number;
  readonly unit?: string;
  readonly referenceLow?: number;
  readonly referenceHigh?: number;
  readonly interpretation?: 'H' | 'L' | 'N';
}

/**
 * A lab report imported for a patient but not recorded: the name printed on
 * it is not the patient's (`name_mismatch`). Nothing reaches the record, so
 * it closes no order, until someone on the team decides: "It's this
 * patient" records it like an accepted report (the engine may then close an
 * order); "Not this patient" discards it. Keyed per clinic by the
 * document's content key, so importing it again never reads it again.
 */
export interface HeldLabReport {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** The import's content key of the document (same patient, date, type and bytes). */
  readonly documentKey: string;
  readonly filename: string;
  /** The date entered with the document. */
  readonly documentDate: Date;
  /** The date the results are recorded with if confirmed (the printed one when read). */
  readonly effectiveAt: Date;
  /** The date printed on the report, when read. */
  readonly printedDate?: Date;
  /** The name printed on the report, and the name in the patient's record (never logged). */
  readonly printedName?: string;
  readonly recordName?: string;
  readonly reason: HeldLabReportReason;
  /** `photo` (vision), `text` (PDF, DOCX, TXT) or `scan` (a PDF with no text layer, read by vision). */
  readonly source: LabReportSource;
  /** `<provider>:<model>` that read it. */
  readonly model?: string;
  readonly results: readonly HeldLabResult[];
  readonly status: HeldLabReportStatus;
  readonly createdAt: Date;
  /** Who decided (the team member's identity) and when. */
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
}
