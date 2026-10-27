import type { Evidence, PatientCondition, PatientConditionStatus } from '@follow-up-engine/core';
import type { Condition, Extension } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { ENGINE_EXTENSIONS, TERMINOLOGY } from '../terminology.ts';
import { concept, ext, patientReference, referenceTo } from './elements.ts';

/**
 * A patient condition as the engine knows it, plus what the API may add:
 * a stable `id` (defaults to `<patientId>-<code>`) and the verbatim quote
 * that supports an extracted condition.
 */
export type PatientConditionInput = PatientCondition & {
  readonly id?: string;
  readonly evidence?: Evidence;
};

/** `Condition.verificationStatus` and `clinicalStatus` codes for each engine status. */
export const CONDITION_STATUS_CODES = {
  confirmed: { verification: 'confirmed', clinical: 'active' },
  probable: { verification: 'provisional', clinical: 'active' },
  resolved: { verification: 'confirmed', clinical: 'resolved' },
} as const satisfies Record<
  PatientConditionStatus,
  { readonly verification: string; readonly clinical: string }
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
      ...ext.string(ENGINE_EXTENSIONS.confirmedBy, condition.confirmedBy),
      ...evidenceExtension(condition.evidence),
    ],
    clinicalStatus: concept(TERMINOLOGY.conditionClinical, codes.clinical),
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
