import {
  type CaseEvent,
  type CaseFeedback,
  caseId,
  type ClinicalEvent,
  type ClinicId,
  type ContactCommunication,
  type ContactRequest,
  contactRequestId,
  type DomainEvent,
  type Expectation,
  expectationId,
  feedbackId,
  type FollowUpCase,
  ICD10_SYSTEM,
  type PatientCondition,
  patientId,
  type PatientId,
  type QualityFinding,
  type RuleSuppression,
  suppressionId,
} from '@follow-up-engine/core';
import { at, uniqueId } from './harness.ts';

/**
 * Valid domain objects for contract tests. Every builder takes the clinic
 * and optional overrides; ids are unique unless overridden.
 */

export function aPatientId(): PatientId {
  return patientId(uniqueId('pat'));
}

export function anExpectation(clinic: ClinicId, overrides: Partial<Expectation> = {}): Expectation {
  const id = uniqueId('exp');
  return {
    id: expectationId(id),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    idempotencyKey: `ServiceRequest/${id}/1#lab_order_result_pending`,
    ruleId: 'lab_order_result_pending',
    ruleVersion: '1.0.0',
    layer: 'universal',
    source: { resourceType: 'ServiceRequest', id },
    matchKey: 'loinc:4548-4',
    dueAt: at(15),
    status: 'open',
    origin: 'live',
    reason: { code: 'lab_result_pending', label: 'Resultado de laboratorio pendiente' },
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

export function aCase(clinic: ClinicId, overrides: Partial<FollowUpCase> = {}): FollowUpCase {
  const id = uniqueId('case');
  return {
    id: caseId(id),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    dedupKey: `pat-1:${id}`,
    reasons: [{ expectationId: expectationId(uniqueId('exp')), reasonCode: 'lab_result_pending' }],
    status: 'open',
    priority: 50,
    escalationStep: 0,
    origin: 'live',
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

export function aFeedback(clinic: ClinicId, overrides: Partial<CaseFeedback> = {}): CaseFeedback {
  return {
    id: feedbackId(uniqueId('fb')),
    clinicId: clinic,
    caseId: caseId('case-1'),
    useful: true,
    createdAt: at(1),
    ...overrides,
  };
}

export function aCondition(
  clinic: ClinicId,
  overrides: Partial<PatientCondition> = {},
): PatientCondition {
  return {
    clinicId: clinic,
    patientId: patientId('pat-1'),
    code: { system: ICD10_SYSTEM, code: 'E11.9', display: 'Type 2 diabetes mellitus' },
    status: 'confirmed',
    confidence: 1,
    sourceType: 'recorded',
    source: { resourceType: 'Condition', id: uniqueId('cond') },
    updatedAt: at(0),
    ...overrides,
  };
}

export function aQualityFinding(
  clinic: ClinicId,
  overrides: Partial<QualityFinding> = {},
): QualityFinding {
  return {
    id: uniqueId('qf'),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    kind: 'note_without_plan',
    source: { resourceType: 'DocumentReference', id: uniqueId('doc') },
    detectedAt: at(0),
    ...overrides,
  };
}

export function aCaseEvent(clinic: ClinicId, overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    clinicId: clinic,
    caseId: caseId('case-1'),
    type: 'opened',
    actor: { type: 'rule', id: 'lab_order_result_pending' },
    payload: { reasons: 1 },
    at: at(0),
    ...overrides,
  };
}

export function aDomainEvent(clinic: ClinicId, overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: uniqueId('evt'),
    type: 'case.opened',
    clinicId: clinic,
    occurredAt: at(0),
    payload: {
      caseId: caseId('case-1'),
      patientId: patientId('pat-1'),
      reasons: [{ code: 'lab_result_pending', label: 'Resultado de laboratorio pendiente' }],
      priority: 50,
      origin: 'live',
    },
    ...overrides,
  } as DomainEvent;
}

/** A `note.received`-free clinical event (encounter finished) for record repository tests. */
export function anEncounterEvent(
  clinic: ClinicId,
  patient: PatientId,
  occurredAt: Date,
  overrides: Partial<ClinicalEvent> = {},
): ClinicalEvent {
  const id = uniqueId('enc');
  return {
    type: 'encounter.finished',
    clinicId: clinic,
    patientId: patient,
    source: { resourceType: 'Encounter', id },
    encounterId: id,
    occurredAt,
    idempotencyKey: `Encounter/${id}/1#encounter.finished`,
    specialty: 'diabetology',
    ...overrides,
  } as ClinicalEvent;
}

export function aContactRequest(
  clinic: ClinicId,
  overrides: Partial<ContactRequest> = {},
): ContactRequest {
  return {
    id: contactRequestId(uniqueId('cr')),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    caseId: caseId('case-1'),
    channel: 'whatsapp',
    purpose: 'schedule_follow_up',
    trigger: 'policy',
    attempt: 1,
    policyStep: 2,
    requestedAt: at(14),
    dueBy: at(21),
    ...overrides,
  };
}

export function aCommunication(
  clinic: ClinicId,
  overrides: Partial<ContactCommunication> = {},
): ContactCommunication {
  return {
    id: uniqueId('comm'),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    caseId: caseId('case-1'),
    requestId: contactRequestId('cr-1'),
    channel: 'whatsapp',
    status: 'completed',
    outcome: 'delivered',
    sentAt: at(14),
    sender: { type: 'host' },
    recordedAt: at(14),
    ...overrides,
  };
}

export function aSuppression(
  clinic: ClinicId,
  overrides: Partial<RuleSuppression> = {},
): RuleSuppression {
  return {
    id: suppressionId(uniqueId('sup')),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    ruleId: 'protocol_diabetes_fundus',
    reason: { code: 'protocol_diabetes_fundus', label: 'Fondo de ojo' },
    dismissReason: 'not_applicable_to_patient',
    createdAt: at(0),
    ...overrides,
  };
}
