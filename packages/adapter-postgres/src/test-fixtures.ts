import { randomUUID } from 'node:crypto';
import {
  clinicId as toClinicId,
  type CaseId,
  type ClinicId,
  type Expectation,
  type ExpectationId,
  type FollowUpCase,
  type PatientId,
} from '@follow-up-engine/core';

/*
 * Synthetic builders for this package's integration tests. Not exported
 * from the package entry point.
 */

export const BASE = new Date('2026-01-05T12:00:00.000Z');

export function at(days: number, hours = 0): Date {
  return new Date(BASE.getTime() + (days * 24 + hours) * 3_600_000);
}

/** A fresh clinic id, so tests sharing a schema never see each other's rows. */
export function newClinic(label = 'clinic'): ClinicId {
  return toClinicId(`${label}-${randomUUID().slice(0, 8)}`);
}

export function patient(id: string): PatientId {
  return id as PatientId;
}

export function makeExpectation(
  clinicId: ClinicId,
  overrides: Partial<Expectation> = {},
): Expectation {
  const id = (overrides.id ?? `exp-${randomUUID()}`) as ExpectationId;
  return {
    id,
    clinicId,
    patientId: patient('pat-1'),
    idempotencyKey: `key-${id}`,
    ruleId: 'lab_order_result_pending',
    ruleVersion: '1.0.0',
    layer: 'universal',
    source: { resourceType: 'ServiceRequest', id: 'sr-1' },
    matchKey: 'order:sr-1',
    dueAt: at(30),
    status: 'open',
    origin: 'live',
    reason: { code: 'lab_result_pending', label: 'Resultado de laboratorio pendiente' },
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

export function makeCase(clinicId: ClinicId, overrides: Partial<FollowUpCase> = {}): FollowUpCase {
  const id = (overrides.id ?? `case-${randomUUID()}`) as CaseId;
  return {
    id,
    clinicId,
    patientId: patient('pat-1'),
    dedupKey: `pat-1:lab`,
    reasons: [{ expectationId: 'exp-1' as ExpectationId, reasonCode: 'lab_result_pending' }],
    status: 'open',
    priority: 1,
    escalationStep: 0,
    origin: 'live',
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}
