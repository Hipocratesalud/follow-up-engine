import {
  ACTIVE_CASE_STATUSES,
  CASE_STATUSES,
  EXPECTATION_LAYERS,
  EXPECTATION_STATUSES,
  caseId as toCaseId,
  clinicId as toClinicId,
  expectationId as toExpectationId,
  patientId as toPatientId,
  type CaseResolutionKind,
  type ClinicId,
  type ConditionSourceType,
  type Evidence,
  type Expectation,
  type FollowUpCase,
  type Origin,
  type PatientConditionStatus,
  type ResourceRef,
} from '@follow-up-engine/core';
import type { CodeableConcept, Condition, Extension, Reference, Task } from '../fhir-types.ts';
import {
  CASE_TASK_CODE,
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  ENGINE_IDENTIFIER_SYSTEMS,
  TERMINOLOGY,
} from '../terminology.ts';
import { parseLiteralReference } from '../support/references.ts';
import type { PatientConditionInput } from './condition.ts';
import { findExtension } from './elements.ts';

/**
 * Reads engine resources back into the domain. Used to prove the outbound
 * representation is lossless (round-trip tests) and by hosts that echo
 * engine resources back. They accept only what the engine itself produces.
 */
export class FhirRepresentationError extends Error {
  override readonly name = 'FhirRepresentationError';
  readonly expression: string;

  constructor(expression: string, message: string) {
    super(`${expression}: ${message}`);
    this.expression = expression;
  }
}

function required<T>(value: T | undefined, expression: string): T {
  if (value === undefined) {
    throw new FhirRepresentationError(expression, 'missing');
  }
  return value;
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
  expression: string,
): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new FhirRepresentationError(expression, `unexpected value ${String(value)}`);
  }
  return value as T;
}

function date(value: string | undefined, expression: string): Date {
  return new Date(required(value, expression));
}

function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function codeIn(concept: CodeableConcept | undefined, system: string): string | undefined {
  return concept?.coding?.find((coding) => coding.system === system)?.code;
}

function refOf(reference: Reference | undefined, expression: string): ResourceRef {
  const parsed = parseLiteralReference(required(reference?.reference, expression));
  return required(parsed, expression);
}

function stringExt(extensions: readonly Extension[] | undefined, url: string): string | undefined {
  const extension = findExtension(extensions, url);
  return extension?.valueString ?? extension?.valueCode;
}

function evidenceOf(extensions: readonly Extension[] | undefined): Evidence | undefined {
  const evidence = findExtension(extensions, ENGINE_EXTENSIONS.evidence);
  if (evidence === undefined) {
    return undefined;
  }
  const quote = required(findExtension(evidence.extension, 'quote')?.valueString, 'evidence.quote');
  const source = refOf(
    findExtension(evidence.extension, 'source')?.valueReference,
    'evidence.source',
  );
  return { quote, sourceDocumentId: source.id };
}

const ORIGINS: readonly Origin[] = ['live', 'backfill'];

/** Reads an expectation Task produced by `expectationToTask`. */
export function taskToExpectation(task: Task, clinicId: ClinicId | string): Expectation {
  const ext = task.extension;
  const caseRef = task.partOf?.[0];
  const protocolId = stringExt(ext, ENGINE_EXTENSIONS.protocolId);
  const protocolVersion = stringExt(ext, ENGINE_EXTENSIONS.protocolVersion);
  const closedReason = codeIn(task.statusReason, ENGINE_CODE_SYSTEMS.closedReason);
  const closedAt = optionalDate(task.executionPeriod?.end);
  const evidence = evidenceOf(ext);
  const reasonCode = required(
    codeIn(task.reasonCode, ENGINE_CODE_SYSTEMS.reason),
    'Task.reasonCode',
  );
  return {
    id: toExpectationId(required(task.id, 'Task.id')),
    clinicId: toClinicId(clinicId),
    patientId: toPatientId(refOf(task.for, 'Task.for').id),
    idempotencyKey: required(
      task.identifier?.find((id) => id.system === ENGINE_IDENTIFIER_SYSTEMS.expectationKey)?.value,
      'Task.identifier',
    ),
    ruleId: required(codeIn(task.code, ENGINE_CODE_SYSTEMS.expectation), 'Task.code'),
    ruleVersion: required(
      stringExt(ext, ENGINE_EXTENSIONS.ruleVersion),
      'Task.extension:ruleVersion',
    ),
    layer: oneOf(
      EXPECTATION_LAYERS,
      stringExt(ext, ENGINE_EXTENSIONS.layer),
      'Task.extension:layer',
    ),
    source: refOf(task.focus, 'Task.focus'),
    matchKey: required(stringExt(ext, ENGINE_EXTENSIONS.matchKey), 'Task.extension:matchKey'),
    dueAt: date(task.restriction?.period?.end, 'Task.restriction.period.end'),
    status: oneOf(
      EXPECTATION_STATUSES,
      codeIn(task.businessStatus, ENGINE_CODE_SYSTEMS.expectationStatus),
      'Task.businessStatus',
    ),
    ...(caseRef === undefined ? {} : { caseId: toCaseId(refOf(caseRef, 'Task.partOf').id) }),
    ...(closedReason === undefined ? {} : { closedReason }),
    ...(closedAt === undefined ? {} : { closedAt }),
    origin: oneOf(ORIGINS, stringExt(ext, ENGINE_EXTENSIONS.origin), 'Task.extension:origin'),
    ...(protocolId === undefined ? {} : { protocolId }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    reason: { code: reasonCode, label: required(task.reasonCode?.text, 'Task.reasonCode.text') },
    ...(evidence === undefined ? {} : { evidence }),
    createdAt: date(task.authoredOn, 'Task.authoredOn'),
    updatedAt: date(task.lastModified, 'Task.lastModified'),
  };
}

const RESOLUTION_KINDS: readonly CaseResolutionKind[] = [
  'fulfilled',
  'handled_outside',
  'not_needed',
  'patient_declined',
  'patient_unreachable',
];

/** Reads a case Task produced by `caseToTask`. */
export function taskToCase(task: Task, clinicId: ClinicId | string): FollowUpCase {
  if (codeIn(task.code, ENGINE_CODE_SYSTEMS.taskType) !== CASE_TASK_CODE) {
    throw new FhirRepresentationError('Task.code', `expected ${CASE_TASK_CODE}`);
  }
  const ext = task.extension;
  const integer = (url: string, name: string): number =>
    required(findExtension(ext, url)?.valueInteger, `Task.extension:${name}`);
  const dateExt = (url: string): Date | undefined =>
    optionalDate(findExtension(ext, url)?.valueDateTime);
  const releaseAt = dateExt(ENGINE_EXTENSIONS.releaseAt);
  const nextActionAt = dateExt(ENGINE_EXTENSIONS.nextActionAt);
  const snoozedUntil = dateExt(ENGINE_EXTENSIONS.snoozedUntil);
  const assignee = task.owner?.identifier?.value;
  const resolutionExt = findExtension(ext, ENGINE_EXTENSIONS.resolution)?.extension;
  const resolvedBy = findExtension(resolutionExt, 'resolvedBy')?.valueString;
  const note = findExtension(resolutionExt, 'note')?.valueString;
  return {
    id: toCaseId(required(task.id, 'Task.id')),
    clinicId: toClinicId(clinicId),
    patientId: toPatientId(refOf(task.for, 'Task.for').id),
    dedupKey: required(stringExt(ext, ENGINE_EXTENSIONS.dedupKey), 'Task.extension:dedupKey'),
    reasons: (task.input ?? []).map((input, index) => ({
      expectationId: toExpectationId(
        refOf(input.valueReference, `Task.input[${String(index)}]`).id,
      ),
      reasonCode: required(
        codeIn(input.type, ENGINE_CODE_SYSTEMS.reason),
        `Task.input[${String(index)}].type`,
      ),
    })),
    status: oneOf(
      CASE_STATUSES,
      codeIn(task.businessStatus, ENGINE_CODE_SYSTEMS.caseStatus),
      'Task.businessStatus',
    ),
    priority: integer(ENGINE_EXTENSIONS.priorityScore, 'priorityScore'),
    ...(assignee === undefined ? {} : { assignee }),
    escalationStep: integer(ENGINE_EXTENSIONS.escalationStep, 'escalationStep'),
    ...(nextActionAt === undefined ? {} : { nextActionAt }),
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
    ...(releaseAt === undefined ? {} : { releaseAt }),
    origin: oneOf(ORIGINS, stringExt(ext, ENGINE_EXTENSIONS.origin), 'Task.extension:origin'),
    ...(resolutionExt === undefined
      ? {}
      : {
          resolution: {
            kind: oneOf(
              RESOLUTION_KINDS,
              findExtension(resolutionExt, 'kind')?.valueCode,
              'Task.extension:resolution.kind',
            ),
            resolvedAt: date(
              findExtension(resolutionExt, 'resolvedAt')?.valueDateTime,
              'Task.extension:resolution.resolvedAt',
            ),
            ...(resolvedBy === undefined ? {} : { resolvedBy }),
            ...(note === undefined ? {} : { note }),
          },
        }),
    createdAt: date(task.authoredOn, 'Task.authoredOn'),
    updatedAt: date(task.lastModified, 'Task.lastModified'),
  };
}

/** Whether a case Task is still being worked (its business status is an active case status). */
export function isActiveCaseTask(task: Task): boolean {
  const status = codeIn(task.businessStatus, ENGINE_CODE_SYSTEMS.caseStatus);
  return (ACTIVE_CASE_STATUSES as readonly (string | undefined)[]).includes(status);
}

const CONDITION_SOURCES: readonly ConditionSourceType[] = [
  'recorded',
  'inferred_from_medication',
  'inferred_from_result',
  'extracted_from_note',
];

/** Reads a Condition produced by `patientConditionToFhir`. */
export function fhirToPatientCondition(
  condition: Condition,
  clinicId: ClinicId | string,
): PatientConditionInput {
  const ext = condition.extension;
  const clinical = codeIn(condition.clinicalStatus, TERMINOLOGY.conditionClinical);
  const verification = codeIn(condition.verificationStatus, TERMINOLOGY.conditionVerification);
  const status: PatientConditionStatus =
    verification === 'refuted'
      ? 'rejected'
      : clinical === 'resolved'
        ? 'resolved'
        : verification === 'provisional'
          ? 'probable'
          : 'confirmed';
  const coding = required(condition.code?.coding?.[0], 'Condition.code.coding');
  const confirmedBy =
    stringExt(ext, ENGINE_EXTENSIONS.confirmedBy) ?? stringExt(ext, ENGINE_EXTENSIONS.refutedBy);
  const evidence = evidenceOf(ext);
  return {
    id: required(condition.id, 'Condition.id'),
    clinicId: toClinicId(clinicId),
    patientId: toPatientId(refOf(condition.subject, 'Condition.subject').id),
    code: {
      system: required(coding.system, 'Condition.code.coding.system'),
      code: required(coding.code, 'Condition.code.coding.code'),
      ...(coding.display === undefined ? {} : { display: coding.display }),
    },
    status,
    confidence: required(
      findExtension(ext, ENGINE_EXTENSIONS.confidence)?.valueDecimal,
      'Condition.extension:confidence',
    ),
    sourceType: oneOf(
      CONDITION_SOURCES,
      stringExt(ext, ENGINE_EXTENSIONS.conditionSource),
      'Condition.extension:conditionSource',
    ),
    source: refOf(condition.evidence?.[0]?.detail?.[0], 'Condition.evidence.detail'),
    ...(confirmedBy === undefined ? {} : { confirmedBy }),
    ...(evidence === undefined ? {} : { evidence }),
    updatedAt: date(condition.meta?.lastUpdated, 'Condition.meta.lastUpdated'),
  };
}
