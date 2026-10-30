import type { HeldLabReport, HeldLabReportStatus } from '../domain/held-lab-report.ts';
import type { ClinicId, PatientId } from '../domain/ids.ts';

/** Imported lab reports held for the team (`HeldLabReport`). Every call is scoped by `clinicId`. */
export interface HeldLabReportStore {
  /**
   * Stores a held report unless the clinic already holds one for the same
   * document key; returns the one stored (the existing one on a repeat).
   */
  hold(report: HeldLabReport): Promise<HeldLabReport>;
  get(clinicId: ClinicId, id: string): Promise<HeldLabReport | undefined>;
  findByDocumentKey(clinicId: ClinicId, documentKey: string): Promise<HeldLabReport | undefined>;
  /** Newest first; only `status` (default every status) and one patient when given. */
  list(
    clinicId: ClinicId,
    query?: { readonly status?: HeldLabReportStatus; readonly patientId?: PatientId },
  ): Promise<readonly HeldLabReport[]>;
  /**
   * Records a decision on a pending report. Returns `undefined` when the
   * report is unknown or no longer pending (decided once, never twice).
   */
  decide(
    clinicId: ClinicId,
    id: string,
    decision: {
      readonly status: Exclude<HeldLabReportStatus, 'pending'>;
      readonly by: string;
      readonly at: Date;
    },
  ): Promise<HeldLabReport | undefined>;
}
