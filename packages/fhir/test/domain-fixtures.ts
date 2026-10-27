import {
  caseId,
  clinicId,
  expectationId,
  patientId,
  type CaseEvent,
  type Expectation,
  type FollowUpCase,
  type QualityFinding,
} from '@follow-up-engine/core';
import type { PatientConditionInput } from '../src/index.ts';

/** Synthetic engine objects for outbound tests. */

export const CLINIC = clinicId('clinic-demo');
export const PATIENT = patientId('pat-dm-0001');

export const openExpectation: Expectation = {
  id: expectationId('exp-hba1c-0001'),
  clinicId: CLINIC,
  patientId: PATIENT,
  idempotencyKey: 'lab.result_pending:ServiceRequest/sr-hba1c',
  ruleId: 'lab.result_pending',
  ruleVersion: '1.0.0',
  layer: 'universal',
  source: { resourceType: 'ServiceRequest', id: 'sr-hba1c' },
  matchKey: 'order:sr-hba1c',
  dueAt: new Date('2026-01-26T12:00:00Z'),
  status: 'open',
  origin: 'live',
  reason: { code: 'lab_result_pending', label: 'Resultado de laboratorio pendiente' },
  createdAt: new Date('2026-01-05T12:00:00Z'),
  updatedAt: new Date('2026-01-05T12:00:00Z'),
};

export const expiredPlanExpectation: Expectation = {
  id: expectationId('exp-plan-0002'),
  clinicId: CLINIC,
  patientId: PATIENT,
  idempotencyKey: 'doctor_plan.follow_up:DocumentReference/note-1:0',
  ruleId: 'doctor_plan.follow_up_visit',
  ruleVersion: '1.2.0',
  layer: 'doctor_plan',
  source: { resourceType: 'DocumentReference', id: 'note-1' },
  matchKey: 'specialty:diabetology',
  dueAt: new Date('2026-04-05T12:00:00Z'),
  status: 'expired',
  caseId: caseId('case-0001'),
  closedReason: 'expired_unmet',
  closedAt: new Date('2026-04-06T00:00:00Z'),
  origin: 'backfill',
  protocolId: 'diabetes.type2',
  protocolVersion: '1.0.0',
  reason: { code: 'follow_up_visit_due', label: 'Control médico pendiente' },
  evidence: { quote: 'Control en 3 meses con resultados.', sourceDocumentId: 'note-1' },
  createdAt: new Date('2026-01-05T12:00:00Z'),
  updatedAt: new Date('2026-04-06T00:00:00Z'),
};

export const escalatedCase: FollowUpCase = {
  id: caseId('case-0001'),
  clinicId: CLINIC,
  patientId: PATIENT,
  dedupKey: 'pat-dm-0001:diabetes_control',
  reasons: [
    { expectationId: expectationId('exp-plan-0002'), reasonCode: 'follow_up_visit_due' },
    { expectationId: expectationId('exp-hba1c-0001'), reasonCode: 'lab_result_pending' },
  ],
  status: 'escalated',
  priority: 70,
  assignee: 'user-reception-1',
  escalationStep: 1,
  nextActionAt: new Date('2026-04-13T12:00:00Z'),
  releaseAt: new Date('2026-04-06T12:00:00Z'),
  origin: 'backfill',
  createdAt: new Date('2026-04-06T00:00:00Z'),
  updatedAt: new Date('2026-04-13T00:00:00Z'),
};

export const resolvedCase: FollowUpCase = {
  ...escalatedCase,
  id: caseId('case-0002'),
  status: 'resolved',
  priority: 40,
  escalationStep: 0,
  origin: 'live',
  resolution: {
    kind: 'handled_outside',
    resolvedAt: new Date('2026-04-10T15:00:00Z'),
    resolvedBy: 'user-doctor-7',
    note: 'Se controló en otra sede.',
  },
};

export const snoozedCase: FollowUpCase = {
  id: caseId('case-0003'),
  clinicId: CLINIC,
  patientId: PATIENT,
  dedupKey: 'pat-dm-0001:imaging',
  reasons: [],
  status: 'snoozed',
  priority: 95,
  escalationStep: 2,
  snoozedUntil: new Date('2026-05-01T12:00:00Z'),
  origin: 'live',
  createdAt: new Date('2026-04-06T00:00:00Z'),
  updatedAt: new Date('2026-04-20T00:00:00Z'),
};

export const extractedCondition: PatientConditionInput = {
  clinicId: CLINIC,
  patientId: PATIENT,
  code: {
    system: 'http://hl7.org/fhir/sid/icd-10',
    code: 'E11.9',
    display: 'Type 2 diabetes mellitus',
  },
  status: 'probable',
  confidence: 0.86,
  sourceType: 'extracted_from_note',
  source: { resourceType: 'DocumentReference', id: 'note-1' },
  evidence: { quote: 'DM2', sourceDocumentId: 'note-1' },
  updatedAt: new Date('2026-01-05T12:00:00Z'),
};

export const confirmedCondition: PatientConditionInput = {
  id: 'cond-htn-1',
  clinicId: CLINIC,
  patientId: PATIENT,
  code: { system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' },
  status: 'confirmed',
  confidence: 0.92,
  sourceType: 'inferred_from_medication',
  source: { resourceType: 'MedicationRequest', id: 'mr-losartan' },
  confirmedBy: 'user-doctor-7',
  updatedAt: new Date('2026-02-01T12:00:00Z'),
};

export const resolvedCondition: PatientConditionInput = {
  ...confirmedCondition,
  id: 'cond-htn-2',
  status: 'resolved',
  sourceType: 'recorded',
  confidence: 1,
};

/** A note-extracted condition the clinician rejected. */
export const rejectedCondition: PatientConditionInput = {
  ...extractedCondition,
  id: 'cond-dm-rejected',
  status: 'rejected',
  confidence: 0,
  confirmedBy: 'user-doctor-7',
  updatedAt: new Date('2026-02-02T12:00:00Z'),
};

export const noteWithoutPlan: QualityFinding = {
  id: 'qf-0001',
  clinicId: CLINIC,
  patientId: PATIENT,
  kind: 'note_without_plan',
  source: { resourceType: 'DocumentReference', id: 'note-2' },
  detectedAt: new Date('2026-01-05T12:01:00Z'),
};

export const caseEvents: readonly CaseEvent[] = [
  {
    clinicId: CLINIC,
    caseId: caseId('case-0001'),
    type: 'opened',
    actor: { type: 'rule', id: 'doctor_plan.follow_up_visit' },
    payload: { expectationIds: ['exp-plan-0002'] },
    at: new Date('2026-04-06T00:00:00Z'),
  },
  {
    clinicId: CLINIC,
    caseId: caseId('case-0001'),
    type: 'escalated',
    actor: { type: 'system' },
    payload: { step: 1, action: 'request_patient_contact' },
    at: new Date('2026-04-13T00:00:00Z'),
  },
  {
    clinicId: CLINIC,
    caseId: caseId('case-0001'),
    type: 'assigned',
    actor: { type: 'user', id: 'user-reception-1' },
    payload: {},
    at: new Date('2026-04-13T09:00:00Z'),
  },
  {
    clinicId: CLINIC,
    caseId: caseId('case-0001'),
    type: 'dismissed',
    actor: { type: 'patient', id: 'pat-dm-0001' },
    payload: {},
    at: new Date('2026-04-14T09:00:00Z'),
  },
];
