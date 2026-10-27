import {
  type ClinicalFinding,
  clinicId,
  FINDING_STATUSES,
  patientId,
} from '@follow-up-engine/core';
import { Ajv } from 'ajv';
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clinicalFindingToDetectedIssue,
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
} from '../src/index.ts';
import { loadFhirR4JsonSchema } from './helpers.ts';

/** A clinical reviewer finding as a FHIR R4 DetectedIssue (HIP-112). */

const finding: ClinicalFinding = {
  id: 'f0c4b7e2-1d3a-4c5b-9e8f-7a6b5c4d3e2f',
  clinicId: clinicId('clinic-demo'),
  patientId: patientId('rev-0001'),
  category: 'drug_condition_conflict',
  severity: 'medium',
  summary: 'Metformin with an estimated GFR of 42 mL/min/1.73m² (CKD-EPI 2021, from creatinine)',
  rationale: 'Metformin with a GFR below 45: the dose needs adjusting.',
  suggestion: 'Consider reviewing the metformin dose (at most 1,000 mg/day) and renal function.',
  citations: [
    {
      source: { resourceType: 'MedicationRequest', id: 'rev-0001-mr13' },
      kind: 'medication',
      quote: 'Metformina 850 mg — 1 tab VO c/12h con las comidas',
      occurredAt: new Date('2025-12-01T14:30:00Z'),
    },
    {
      source: { resourceType: 'Observation', id: 'rev-0001-lab20-creatinine' },
      kind: 'result',
      quote: 'Creatinine: 1.75 mg/dL',
      occurredAt: new Date('2025-11-21T09:00:00Z'),
    },
  ],
  alreadyCovered: false,
  coveredBy: [],
  specialty: 'diabetology',
  mode: 'shadow',
  status: 'open',
  origin: 'confirmed',
  dedupKey:
    'drug_condition_conflict|MedicationRequest/rev-0001-mr13,Observation/rev-0001-lab20-creatinine',
  runId: 'run-1',
  modelId: 'fake:fake-reviewer',
  promptVersion: 'clinical-review@1',
  createdAt: new Date('2026-01-05T12:10:00Z'),
  updatedAt: new Date('2026-01-05T12:10:00Z'),
};

let validate: (resource: unknown) => string[];

beforeAll(() => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addMetaSchema(draft06);
  ajv.addSchema(loadFhirR4JsonSchema());
  const compiled = ajv.compile({
    $ref: 'http://hl7.org/fhir/json-schema/4.0#/definitions/DetectedIssue',
  });
  validate = (resource) =>
    compiled(resource)
      ? []
      : (compiled.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`);
});

describe('clinicalFindingToDetectedIssue', () => {
  it('maps the finding, its cited evidence and its suggestion', () => {
    const issue = clinicalFindingToDetectedIssue(finding);
    expect(issue).toMatchObject({
      resourceType: 'DetectedIssue',
      status: 'preliminary',
      severity: 'moderate',
      code: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.clinicalFinding, code: 'drug-condition-conflict' }],
        text: finding.summary,
      },
      patient: { reference: 'Patient/rev-0001' },
      identifiedDateTime: '2026-01-05T12:10:00.000Z',
      implicated: [
        { reference: 'MedicationRequest/rev-0001-mr13', type: 'MedicationRequest' },
        { reference: 'Observation/rev-0001-lab20-creatinine', type: 'Observation' },
      ],
      evidence: [
        {
          detail: [
            {
              reference: 'MedicationRequest/rev-0001-mr13',
              display: 'Metformina 850 mg — 1 tab VO c/12h con las comidas',
            },
            {
              reference: 'Observation/rev-0001-lab20-creatinine',
              display: 'Creatinine: 1.75 mg/dL',
            },
          ],
        },
      ],
      detail: finding.rationale,
      mitigation: [{ action: { text: finding.suggestion } }],
    });
    expect(issue.extension).toEqual([
      { url: ENGINE_EXTENSIONS.findingMode, valueCode: 'shadow' },
      { url: ENGINE_EXTENSIONS.alreadyCovered, valueBoolean: false },
      { url: ENGINE_EXTENSIONS.findingOrigin, valueCode: 'confirmed' },
      {
        url: ENGINE_EXTENSIONS.reviewerModel,
        valueString: 'fake:fake-reviewer (clinical-review@1)',
      },
    ]);
  });

  it.each(FINDING_STATUSES)('conforms to the FHIR R4 JSON Schema (%s)', (status) => {
    const reviewed: ClinicalFinding =
      status === 'open' || status === 'expired'
        ? { ...finding, status }
        : {
            ...finding,
            status,
            mode: 'live',
            review: {
              verdict: status,
              reviewedBy: 'dra-castellanos',
              reviewedAt: new Date('2026-01-06T10:00:00Z'),
            },
          };
    const issue = clinicalFindingToDetectedIssue(reviewed);
    expect(validate(issue)).toEqual([]);
    expect(issue.status).toBe(
      {
        open: 'preliminary',
        relevant: 'final',
        already_known: 'final',
        not_relevant: 'cancelled',
        expired: 'cancelled',
      }[status],
    );
  });
});
