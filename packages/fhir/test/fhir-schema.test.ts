import { Ajv, type ValidateFunction } from 'ajv';
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import type { CaseStatus, ExpectationStatus } from '@follow-up-engine/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildConsultationBundle,
  caseEventToProvenance,
  caseToTask,
  communicationToFhir,
  contactRequestToFhir,
  expectationToTask,
  mapBundleToBatches,
  patientConditionToFhir,
  qualityFindingToDetectedIssue,
  suppressionToFlag,
  toSearchsetBundle,
  type FhirResource,
} from '../src/index.ts';
import {
  activeSuppression,
  callAttempt,
  callBooked,
  caseEvents,
  confirmedCondition,
  dismissedCase,
  hostPolicyAttempt,
  revokedSuppression,
  whatsappAttempt,
  wrongNumber,
  escalatedCase,
  expiredPlanExpectation,
  extractedCondition,
  noteWithoutPlan,
  openExpectation,
  resolvedCase,
  resolvedCondition,
  snoozedCase,
} from './domain-fixtures.ts';
import { loadBundle, loadFhirR4JsonSchema } from './helpers.ts';

/**
 * Every resource the package emits, and every fixture it consumes, is
 * validated against the official HL7 FHIR R4 JSON Schema
 * (fixtures/schema/fhir.schema.json.zip, from https://hl7.org/fhir/R4/).
 */

const SCHEMA_ID = 'http://hl7.org/fhir/json-schema/4.0';
const validators = new Map<string, ValidateFunction>();
let ajv: Ajv;

beforeAll(() => {
  ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addMetaSchema(draft06);
  ajv.addSchema(loadFhirR4JsonSchema());
});

function validatorFor(resourceType: string): ValidateFunction {
  let validate = validators.get(resourceType);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: `${SCHEMA_ID}#/definitions/${resourceType}` });
    validators.set(resourceType, validate);
  }
  return validate;
}

function schemaErrors(resource: { readonly resourceType: string }): string[] {
  const validate = validatorFor(resource.resourceType);
  return validate(resource)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`);
}

const EXPECTATION_STATUSES: readonly ExpectationStatus[] = [
  'open',
  'fulfilled',
  'superseded',
  'expired',
  'cancelled',
];
const CASE_STATUSES: readonly CaseStatus[] = [
  'open',
  'notified',
  'snoozed',
  'escalated',
  'resolved',
  'dismissed',
  'lost_to_follow_up',
];

const outbound: readonly [string, FhirResource][] = [
  ...[openExpectation, expiredPlanExpectation].flatMap((expectation) =>
    EXPECTATION_STATUSES.map((status): [string, FhirResource] => [
      `expectation Task ${expectation.id} (${status})`,
      expectationToTask({ ...expectation, status }),
    ]),
  ),
  ...CASE_STATUSES.map((status): [string, FhirResource] => [
    `case Task (${status})`,
    caseToTask({ ...escalatedCase, status }),
  ]),
  ['resolved case Task', caseToTask(resolvedCase)],
  ['dismissed case Task', caseToTask(dismissedCase)],
  ['CommunicationRequest (WhatsApp)', contactRequestToFhir(whatsappAttempt)],
  ['CommunicationRequest (call, by a user)', contactRequestToFhir(callAttempt)],
  ['CommunicationRequest (host channel)', contactRequestToFhir(hostPolicyAttempt)],
  [
    'CommunicationRequest (completed)',
    contactRequestToFhir(whatsappAttempt, { communications: [wrongNumber] }),
  ],
  ['Communication (wrong number)', communicationToFhir(wrongNumber)],
  ['Communication (call recorded in the inbox)', communicationToFhir(callBooked)],
  ['Flag (active suppression)', suppressionToFlag(activeSuppression)],
  ['Flag (reactivated)', suppressionToFlag(revokedSuppression)],
  ['snoozed case Task', caseToTask(snoozedCase)],
  ['extracted Condition', patientConditionToFhir(extractedCondition)],
  ['confirmed Condition', patientConditionToFhir(confirmedCondition)],
  ['resolved Condition', patientConditionToFhir(resolvedCondition)],
  ['DetectedIssue', qualityFindingToDetectedIssue(noteWithoutPlan)],
  ...caseEvents.map((event): [string, FhirResource] => [
    `Provenance (${event.type})`,
    caseEventToProvenance(event),
  ]),
  [
    'searchset Bundle',
    toSearchsetBundle([caseToTask(escalatedCase), expectationToTask(openExpectation)], {
      baseUrl: 'https://engine.example.org/fhir',
      selfUrl: 'https://engine.example.org/fhir/Task',
      timestamp: new Date('2026-04-13T00:00:00Z'),
    }),
  ],
  ['empty searchset Bundle', toSearchsetBundle([])],
];

describe('outbound resources conform to the FHIR R4 JSON Schema', () => {
  it.each(outbound)('%s', (_name, resource) => {
    expect(schemaErrors(resource)).toEqual([]);
  });
});

const VALID_FIXTURES = [
  'consultation-diabetology',
  'consultation-hypertension',
  'consultation-psychology',
  'consultation-gynecology',
  'result-hba1c',
  'appointment-booked',
  'appointment-cancelled',
  'patient-opt-out',
  'communication-outcome',
] as const;

describe('inbound fixtures and what the mapping stores conform too', () => {
  it.each(VALID_FIXTURES)('%s', (name) => {
    const bundle = loadBundle(name) as { resourceType: string };
    expect(schemaErrors(bundle)).toEqual([]);
    const { resources } = mapBundleToBatches(bundle, {
      clinicId: 'clinic-demo',
      receivedAt: new Date('2026-01-05T20:00:00Z'),
    });
    for (const { resource } of resources) {
      expect(schemaErrors(resource), `${resource.resourceType}/${resource.id}`).toEqual([]);
    }
  });

  it('the validator is not vacuous: an engine status in Task.status is rejected', () => {
    const engineStatusInTask = { resourceType: 'Task', status: 'open', intent: 'plan' };
    expect(schemaErrors(engineStatusInTask)).not.toEqual([]);
  });

  it('the invalid fixture is caught by the schema too (bad dateTime)', () => {
    expect(
      schemaErrors(loadBundle('invalid-consultation') as { resourceType: string }),
    ).not.toEqual([]);
  });

  it('OperationOutcomes conform', () => {
    const { issues } = mapBundleToBatches(loadBundle('invalid-consultation'), {
      clinicId: 'clinic-demo',
      receivedAt: new Date('2026-01-05T20:00:00Z'),
    });
    expect(issues).toBeDefined();
    expect(schemaErrors(issues ?? { resourceType: 'OperationOutcome' })).toEqual([]);
  });

  it('the consultation builder emits a conformant transaction', () => {
    const bundle = buildConsultationBundle({
      consultationId: 'demo-0001',
      patient: {
        id: 'pat-demo-1',
        name: 'Paciente Demo',
        gender: 'female',
        birthDate: '1970-05-01',
      },
      practitionerId: 'doc-1',
      specialty: 'diabetology',
      occurredAt: new Date('2026-01-05T12:00:00Z'),
      noteText: 'DM2. Plan: HbA1c y control en 3 meses.',
      orders: [
        { loinc: '4548-4', display: 'HbA1c' },
        { loinc: '24627-2', display: 'Radiografía de tórax', category: 'imaging' },
      ],
      prescriptions: [{ text: 'metformina 850 mg c/12h', durationDays: 90 }],
      diagnoses: [
        { icd10: 'E11.9', display: 'DM2' },
        { icd10: 'E78.5', verification: 'provisional' },
      ],
    });
    expect(schemaErrors(bundle)).toEqual([]);
  });
});
