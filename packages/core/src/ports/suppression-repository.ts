import type { RuleSuppression } from '../domain/contact.ts';
import type { ClinicId, PatientId, SuppressionId } from '../domain/ids.ts';

/**
 * Per-patient suppressions of a rule or protocol item. At most one active
 * suppression per patient and rule; revoked ones stay as history (audit).
 * Adapters throw `TenantMismatchError` when a value's `clinicId` differs.
 */
export interface SuppressionRepository {
  /** Throws `ConflictError` when the patient already has an active suppression of the rule, or the id exists. */
  create(clinicId: ClinicId, suppression: RuleSuppression): Promise<void>;

  get(clinicId: ClinicId, id: SuppressionId): Promise<RuleSuppression | undefined>;

  /** The patient's suppressions, revoked ones too unless `activeOnly`, newest first. */
  listForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    options?: { readonly activeOnly?: boolean },
  ): Promise<readonly RuleSuppression[]>;

  /**
   * Revokes an active suppression ("Volver a activar"). Returns the revoked
   * suppression; `undefined` when it does not exist or was already revoked.
   */
  revoke(
    clinicId: ClinicId,
    id: SuppressionId,
    input: { readonly revokedAt: Date; readonly revokedBy?: string },
  ): Promise<RuleSuppression | undefined>;
}
