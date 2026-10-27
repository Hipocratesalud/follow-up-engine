import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';

/** `closedReason` of an expectation withdrawn because its rule no longer applies to the patient. */
export const SUPPRESSED_FOR_PATIENT = 'suppressed_for_patient';

/** The rule ids suppressed for a patient right now: no layer creates their expectations. */
export async function suppressedRuleIds(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<ReadonlySet<string>> {
  const active = await stores.suppressions.listForPatient(clinicId, patientId, {
    activeOnly: true,
  });
  return new Set(active.map((suppression) => suppression.ruleId));
}
