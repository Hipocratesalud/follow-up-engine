import {
  type Evidence,
  ICD10_SYSTEM,
  type PatientCondition,
  type PatientConditionStatus,
} from '@follow-up-engine/core';
import type { Condition, Extension } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { ENGINE_EXTENSIONS, TERMINOLOGY } from '../terminology.ts';
import { concept, ext, patientReference, referenceTo } from './elements.ts';

/**
 * A core `PatientCondition` (its `evidence` included), plus the FHIR id the
 * API may choose (defaults to {@link conditionId}).
 */
export type PatientConditionInput = PatientCondition & { readonly id?: string };

/**
 * `Condition.verificationStatus` and `clinicalStatus` codes for each engine
 * status. A rejection (by a clinician or by the host) is `refuted` (never
 * `confirmed`); its clinical status is `inactive`, since R4 (con-3) requires
 * one on a problem-list item that is not entered-in-error. A condition that
 * was never the patient's is `entered-in-error`, without a clinical status
 * (con-5).
 */
export const CONDITION_STATUS_CODES = {
  confirmed: { verification: 'confirmed', clinical: 'active' },
  probable: { verification: 'provisional', clinical: 'active' },
  resolved: { verification: 'confirmed', clinical: 'resolved' },
  rejected: { verification: 'refuted', clinical: 'inactive' },
  entered_in_error: { verification: 'entered-in-error', clinical: undefined },
} as const satisfies Record<
  PatientConditionStatus,
  { readonly verification: string; readonly clinical: string | undefined }
>;

/** Default FHIR id of a patient condition: unique per patient and code. */
export function conditionId(condition: Pick<PatientCondition, 'patientId' | 'code'>): string {
  return toFhirId(`${condition.patientId}-${condition.code.code}`);
}

function evidenceExtension(evidence: Evidence | undefined): Extension[] {
  return evidence === undefined
    ? []
    : ext.complex(ENGINE_EXTENSIONS.evidence, [
        { url: 'quote', valueString: evidence.quote },
        {
          url: 'source',
          valueReference: referenceTo({
            resourceType: 'DocumentReference',
            id: evidence.sourceDocumentId,
          }),
        },
      ]);
}

/**
 * A patient condition as a FHIR `Condition` (problem-list item). Inferred
 * conditions are `provisional` until a clinician confirms them; the
 * engine's confidence, how it learned the condition and the supporting quote
 * travel in extensions, and `evidence.detail` points at the source resource.
 */
export function patientConditionToFhir(condition: PatientConditionInput): Condition {
  const codes = CONDITION_STATUS_CODES[condition.status];
  return {
    resourceType: 'Condition',
    id: condition.id === undefined ? conditionId(condition) : toFhirId(condition.id),
    meta: { lastUpdated: toFhirInstant(condition.updatedAt) },
    extension: [
      ...ext.decimal(ENGINE_EXTENSIONS.confidence, condition.confidence),
      ...ext.code(ENGINE_EXTENSIONS.conditionSource, condition.sourceType),
      ...ext.string(
        condition.status === 'rejected'
          ? ENGINE_EXTENSIONS.refutedBy
          : ENGINE_EXTENSIONS.confirmedBy,
        condition.confirmedBy,
      ),
      ...evidenceExtension(condition.evidence),
    ],
    ...(codes.clinical === undefined
      ? {}
      : { clinicalStatus: concept(TERMINOLOGY.conditionClinical, codes.clinical) }),
    verificationStatus: concept(TERMINOLOGY.conditionVerification, codes.verification),
    category: [concept(TERMINOLOGY.conditionCategory, 'problem-list-item')],
    code: {
      coding: [
        {
          system: condition.code.system,
          code: condition.code.code,
          ...(condition.code.display === undefined ? {} : { display: condition.code.display }),
        },
      ],
      ...(condition.code.display === undefined ? {} : { text: condition.code.display }),
    },
    subject: patientReference(condition.patientId),
    evidence: [{ detail: [referenceTo(condition.source)] }],
  };
}

function icd10Key(code: string): string {
  return code.replace('.', '').trim().toUpperCase();
}

/**
 * The conditions to show a host: drops a provisional (`probable`) ICD-10 code
 * when a confirmed code of the same or a more specific concept exists (a note
 * says "DM2" → provisional `E11`; the chart records confirmed `E11.9`): the
 * host would otherwise read "diabetes, unconfirmed" for a patient whose
 * doctor recorded it. Rejected and resolved conditions are always kept.
 */
export function exportableConditions<TCondition extends PatientCondition>(
  conditions: readonly TCondition[],
): TCondition[] {
  const confirmed = conditions
    .filter(
      (condition) => condition.status === 'confirmed' && condition.code.system === ICD10_SYSTEM,
    )
    .map((condition) => icd10Key(condition.code.code));
  return conditions.filter(
    (condition) =>
      condition.status !== 'probable' ||
      condition.code.system !== ICD10_SYSTEM ||
      !confirmed.some((code) => code.startsWith(icd10Key(condition.code.code))),
  );
}
