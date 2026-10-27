import type { Expectation, ExpectationStatus } from '@follow-up-engine/core';
import type { Extension, Task } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  ENGINE_IDENTIFIER_SYSTEMS,
} from '../terminology.ts';
import {
  concept,
  ext,
  isRequestResource,
  patientReference,
  referenceTo,
  taskReference,
} from './elements.ts';

/**
 * FHIR `Task.status` for each expectation status. The exact engine status
 * always travels in `Task.businessStatus`.
 */
export const EXPECTATION_TASK_STATUS = {
  open: 'requested',
  fulfilled: 'completed',
  superseded: 'cancelled',
  cancelled: 'cancelled',
  expired: 'failed',
} as const satisfies Record<ExpectationStatus, Task['status']>;

function evidenceExtension(expectation: Expectation): Extension[] {
  const { evidence } = expectation;
  if (evidence === undefined) {
    return [];
  }
  return ext.complex(ENGINE_EXTENSIONS.evidence, [
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
 * An expectation as a FHIR `Task` (intent `plan`): "this should happen for
 * this patient by `restriction.period.end`".
 *
 * - `code`: the rule id, in the engine expectation CodeSystem.
 * - `status`: {@link EXPECTATION_TASK_STATUS}; `businessStatus`: the exact engine status.
 * - `focus` (and `basedOn` for orders and prescriptions): the triggering resource.
 * - `partOf`: the case Task once the expectation was grouped into a case.
 */
export function expectationToTask(expectation: Expectation): Task {
  const source = referenceTo(expectation.source);
  const extension: Extension[] = [
    ...ext.code(ENGINE_EXTENSIONS.layer, expectation.layer),
    ...ext.string(ENGINE_EXTENSIONS.ruleVersion, expectation.ruleVersion),
    ...ext.string(ENGINE_EXTENSIONS.protocolId, expectation.protocolId),
    ...ext.string(ENGINE_EXTENSIONS.protocolVersion, expectation.protocolVersion),
    ...ext.code(ENGINE_EXTENSIONS.origin, expectation.origin),
    ...ext.string(ENGINE_EXTENSIONS.matchKey, expectation.matchKey),
    ...evidenceExtension(expectation),
  ];
  return {
    resourceType: 'Task',
    id: toFhirId(expectation.id),
    extension,
    identifier: [
      { system: ENGINE_IDENTIFIER_SYSTEMS.expectationKey, value: expectation.idempotencyKey },
    ],
    ...(isRequestResource(expectation.source) ? { basedOn: [source] } : {}),
    ...(expectation.caseId === undefined ? {} : { partOf: [taskReference(expectation.caseId)] }),
    status: EXPECTATION_TASK_STATUS[expectation.status],
    ...(expectation.closedReason === undefined
      ? {}
      : { statusReason: concept(ENGINE_CODE_SYSTEMS.closedReason, expectation.closedReason) }),
    businessStatus: concept(
      ENGINE_CODE_SYSTEMS.expectationStatus,
      expectation.status,
      expectation.status,
    ),
    intent: 'plan',
    code: concept(ENGINE_CODE_SYSTEMS.expectation, expectation.ruleId, expectation.reason.label),
    description: expectation.reason.label,
    focus: source,
    for: patientReference(expectation.patientId),
    executionPeriod: {
      start: toFhirInstant(expectation.createdAt),
      ...(expectation.closedAt === undefined ? {} : { end: toFhirInstant(expectation.closedAt) }),
    },
    authoredOn: toFhirInstant(expectation.createdAt),
    lastModified: toFhirInstant(expectation.updatedAt),
    reasonCode: concept(
      ENGINE_CODE_SYSTEMS.reason,
      expectation.reason.code,
      expectation.reason.label,
    ),
    restriction: { period: { end: toFhirInstant(expectation.dueAt) } },
  };
}
