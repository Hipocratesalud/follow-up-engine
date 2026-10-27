import type { QualityFinding, QualityFindingKind } from '@follow-up-engine/core';
import type { DetectedIssue } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import {
  ENGINE_CODE_SYSTEMS,
  NOTE_TRUNCATED_CODE,
  NOTE_WITHOUT_PLAN_CODE,
} from '../terminology.ts';
import { patientReference, referenceTo } from './elements.ts';

/** `DetectedIssue.code` (engine quality-finding CodeSystem) for each finding kind. */
export const QUALITY_FINDING_CODES = {
  note_without_plan: {
    code: NOTE_WITHOUT_PLAN_CODE,
    display: 'Clinical note without a follow-up plan',
  },
  note_truncated: {
    code: NOTE_TRUNCATED_CODE,
    display: 'Clinical note too long to be read whole; its follow-up plan may be incomplete',
  },
} as const satisfies Record<
  QualityFindingKind,
  { readonly code: string; readonly display: string }
>;

/**
 * A documentation-quality finding as a FHIR `DetectedIssue` for the
 * clinician (never the patient): `implicated` points at the document.
 */
export function qualityFindingToDetectedIssue(finding: QualityFinding): DetectedIssue {
  const code = QUALITY_FINDING_CODES[finding.kind];
  return {
    resourceType: 'DetectedIssue',
    id: toFhirId(finding.id),
    status: 'preliminary',
    code: {
      coding: [
        { system: ENGINE_CODE_SYSTEMS.qualityFinding, code: code.code, display: code.display },
      ],
      text: code.display,
    },
    severity: 'low',
    patient: patientReference(finding.patientId),
    identifiedDateTime: toFhirInstant(finding.detectedAt),
    implicated: [referenceTo(finding.source)],
  };
}
