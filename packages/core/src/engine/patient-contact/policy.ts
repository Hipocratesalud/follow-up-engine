import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { enrollingConditions } from '../annotator/conditions.ts';
import type { Catalog } from '../catalog.ts';
import { addDays } from '../support/time.ts';

/** Why the engine did not ask the host to contact the patient. */
export type PatientContactDenial =
  'clinic_disallows_contact' | 'patient_opted_out' | 'low_confidence' | 'contact_window';

export type PatientContactDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: PatientContactDenial };

export interface PatientContactInput {
  readonly clinicAllowsContact: boolean;
  readonly patientOptedOut: boolean;
  /** Every reason of the case rests on a probable (unconfirmed) condition. */
  readonly lowConfidence: boolean;
  /** Last contact request for this patient, from any case. */
  readonly lastContactAt?: Date;
  readonly now: Date;
  readonly windowDays: number;
}

/**
 * Whether the engine may ask the host to message the patient. At most one
 * request per patient per window whatever the number of open cases; never
 * for patients who opted out, clinics that do not allow it, or cases built
 * only on probable conditions. The request itself never names a diagnosis
 * (see `PatientContactRequestedPayload`).
 */
export function decidePatientContact(input: PatientContactInput): PatientContactDecision {
  if (!input.clinicAllowsContact) {
    return { allowed: false, reason: 'clinic_disallows_contact' };
  }
  if (input.patientOptedOut) {
    return { allowed: false, reason: 'patient_opted_out' };
  }
  if (input.lowConfidence) {
    return { allowed: false, reason: 'low_confidence' };
  }
  if (
    input.lastContactAt !== undefined &&
    addDays(input.lastContactAt, input.windowDays).getTime() > input.now.getTime()
  ) {
    return { allowed: false, reason: 'contact_window' };
  }
  return { allowed: true };
}

/**
 * A case is low confidence when all its reasons come from protocols the
 * patient is enrolled in only through probable conditions (inferred from a
 * medication, a result or a note, never confirmed by a clinician).
 */
export function isLowConfidenceCase(
  reasons: readonly Expectation[],
  conditions: readonly PatientCondition[],
  catalog: Catalog,
): boolean {
  if (reasons.length === 0) {
    return false;
  }
  return reasons.every((expectation) => {
    if (expectation.layer !== 'protocol' || expectation.protocolId === undefined) {
      return false;
    }
    const protocol = catalog.protocols.find((candidate) => candidate.id === expectation.protocolId);
    if (protocol === undefined) {
      return true;
    }
    return !enrollingConditions(protocol, conditions).some(
      (condition) => condition.status === 'confirmed',
    );
  });
}
