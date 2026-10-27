import type { Brand } from '../shared/brand.ts';

/** Tenant identifier. Every stored row and every query is scoped by it. */
export type ClinicId = Brand<string, 'ClinicId'>;

/** Patient identifier, unique within a clinic (the host EHR's patient id). */
export type PatientId = Brand<string, 'PatientId'>;

/** Identifier of an expectation (a FHIR `Task` the engine watches). */
export type ExpectationId = Brand<string, 'ExpectationId'>;

/** Identifier of a case (a FHIR `Task` opened per patient and reason). */
export type CaseId = Brand<string, 'CaseId'>;

/** Identifier of a piece of clinician feedback on an expectation or case. */
export type FeedbackId = Brand<string, 'FeedbackId'>;

/** Identifier of a job in the job queue / transactional outbox. */
export type JobId = Brand<string, 'JobId'>;

/** Raised when a raw value cannot be turned into a domain identifier. */
export class InvalidIdentifierError extends Error {
  override readonly name = 'InvalidIdentifierError';
  readonly kind: string;
  readonly value: unknown;

  constructor(kind: string, value: unknown) {
    super(`Invalid ${kind}: expected a non-empty string without surrounding whitespace`);
    this.kind = kind;
    this.value = value;
  }
}

function requireIdentifier(kind: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new InvalidIdentifierError(kind, value);
  }
  return value;
}

/** Parses a raw string into a {@link ClinicId}. Throws {@link InvalidIdentifierError}. */
export function clinicId(value: string): ClinicId {
  return requireIdentifier('ClinicId', value) as ClinicId;
}

/** Parses a raw string into a {@link PatientId}. Throws {@link InvalidIdentifierError}. */
export function patientId(value: string): PatientId {
  return requireIdentifier('PatientId', value) as PatientId;
}

/** Parses a raw string into an {@link ExpectationId}. Throws {@link InvalidIdentifierError}. */
export function expectationId(value: string): ExpectationId {
  return requireIdentifier('ExpectationId', value) as ExpectationId;
}

/** Parses a raw string into a {@link CaseId}. Throws {@link InvalidIdentifierError}. */
export function caseId(value: string): CaseId {
  return requireIdentifier('CaseId', value) as CaseId;
}

/** Parses a raw string into a {@link FeedbackId}. Throws {@link InvalidIdentifierError}. */
export function feedbackId(value: string): FeedbackId {
  return requireIdentifier('FeedbackId', value) as FeedbackId;
}

/** Parses a raw string into a {@link JobId}. Throws {@link InvalidIdentifierError}. */
export function jobId(value: string): JobId {
  return requireIdentifier('JobId', value) as JobId;
}
