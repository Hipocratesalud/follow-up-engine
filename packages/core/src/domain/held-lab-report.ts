import type { ClinicId, PatientId } from './ids.ts';

/** Why an imported lab report was held instead of recorded. */
export const HELD_LAB_REPORT_REASONS = ['name_mismatch'] as const;
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
  /** `photo` (vision) or `text` (PDF, DOCX, TXT). */
  readonly source: 'photo' | 'text';
  /** `<provider>:<model>` that read it. */
  readonly model?: string;
  readonly results: readonly HeldLabResult[];
  readonly status: HeldLabReportStatus;
  readonly createdAt: Date;
  /** Who decided (the team member's identity) and when. */
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
}
