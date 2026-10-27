import type { ClinicalFinding, FindingSeverity, FindingStatus } from '@follow-up-engine/core';
import type { DetectedIssue } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { ENGINE_CODE_SYSTEMS, ENGINE_EXTENSIONS } from '../terminology.ts';
import { ext, hostUserReference, patientReference, referenceTo } from './elements.ts';

/** English display of each finding category (the code is the category in kebab case). */
export const CLINICAL_FINDING_DISPLAYS: Readonly<Record<ClinicalFinding['category'], string>> = {
  pre_visit_question: 'Question for the next visit',
  lab_trend: 'Silent laboratory trend',
  vital_trend: 'Vital sign trend',
  abnormal_result_no_followup: 'Abnormal result without follow-up',
  drug_interaction: 'Drug-drug interaction',
  drug_condition_conflict: 'Drug-condition conflict',
  unaddressed_symptom: 'Recurring symptom without workup',
  missing_screening: 'Missing check-up',
  record_quality: 'Record quality',
  utilization_change: 'Change in clinic use',
  similar_patients: 'Similar patients (reserved)',
};

const SEVERITY: Readonly<Record<FindingSeverity, DetectedIssue['severity']>> = {
  low: 'low',
  medium: 'moderate',
  high: 'high',
};

/** An unreviewed finding is preliminary; a confirmed one final; a rejected or expired one cancelled. */
const STATUS: Readonly<Record<FindingStatus, DetectedIssue['status']>> = {
  open: 'preliminary',
  relevant: 'final',
  already_known: 'final',
  not_relevant: 'cancelled',
  expired: 'cancelled',
};

/**
 * A clinical reviewer finding as a FHIR R4 `DetectedIssue` for the clinical
 * team (never the patient): `implicated` and `evidence.detail` reference the
 * cited documents, each `evidence.detail.display` carrying the verbatim
 * quote; `detail` is the rationale and `mitigation.action.text` the
 * suggestion. Extensions say whether it is a shadow finding, whether an
 * open follow-up already covers it, and which model produced it.
 */
export function clinicalFindingToDetectedIssue(finding: ClinicalFinding): DetectedIssue {
  const category = finding.category.replace(/_/g, '-');
  const references = finding.citations.map((citation) => ({
    ...referenceTo(citation.source),
    display: citation.quote.length > 500 ? `${citation.quote.slice(0, 499)}…` : citation.quote,
  }));
  const implicated = [
    ...new Map(
      finding.citations.map((citation) => {
        const reference = referenceTo(citation.source);
        return [reference.reference, reference] as const;
      }),
    ).values(),
  ];
  return {
    resourceType: 'DetectedIssue',
    id: toFhirId(finding.id),
    extension: [
      ...ext.code(ENGINE_EXTENSIONS.findingMode, finding.mode),
      { url: ENGINE_EXTENSIONS.alreadyCovered, valueBoolean: finding.alreadyCovered },
      ...ext.code(ENGINE_EXTENSIONS.findingOrigin, finding.origin),
      ...ext.string(
        ENGINE_EXTENSIONS.reviewerModel,
        `${finding.modelId} (${finding.promptVersion})`,
      ),
    ],
    status: STATUS[finding.status],
    code: {
      coding: [
        {
          system: ENGINE_CODE_SYSTEMS.clinicalFinding,
          code: category,
          display: CLINICAL_FINDING_DISPLAYS[finding.category],
        },
      ],
      text: finding.summary,
    },
    severity: SEVERITY[finding.severity],
    patient: patientReference(finding.patientId),
    identifiedDateTime: toFhirInstant(finding.createdAt),
    author: { type: 'Device', display: 'Follow-up Engine clinical reviewer' },
    implicated,
    evidence: [{ detail: references }],
    detail: finding.rationale,
    mitigation: [
      {
        action: { text: finding.suggestion },
        ...(finding.review === undefined
          ? {}
          : {
              date: toFhirInstant(finding.review.reviewedAt),
              author: hostUserReference(finding.review.reviewedBy),
            }),
      },
    ],
  };
}
