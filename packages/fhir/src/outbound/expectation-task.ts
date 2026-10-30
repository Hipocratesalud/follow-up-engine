import {
  effectiveClosedReason,
  type Expectation,
  type ExpectationStatus,
} from '@follow-up-engine/core';
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
 * - A plan item a clinician reviewed (HIP-141): `confirmedBy` / `confirmedAt`
 *   extensions; a correction points at the Task it replaced (`correctionOf`),
 *   which ends `cancelled` with `statusReason` `corrected_by_clinician`; a
 *   rejected one ends `cancelled` with `rejected_by_clinician`.
 * - A closure reclassified after the fact (a `covered_by_order` plan item
 *   whose order the end of the pregnancy cancelled): `statusReason` is the
 *   reason it reads as now (`pregnancy_ended`), the
 *   `closureReclassification` extension the original reason and when and
 *   by what it changed.
 */
/** `closedReason` of an expectation that expired without one recorded. */
export const EXPIRED_UNMET_REASON = 'expired_unmet';

/**
 * Why and when the expectation stopped being pending. An expired one
 * always says so (`expired_unmet`, ended when it last changed), even when
 * the engine recorded no `closedReason` / `closedAt` for the expiry.
 */
function closure(expectation: Expectation): { reason?: string; end?: Date } {
  const reason = effectiveClosedReason(expectation);
  if (expectation.status === 'expired') {
    return {
      reason: reason ?? EXPIRED_UNMET_REASON,
      end: expectation.closedAt ?? expectation.updatedAt,
    };
  }
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(expectation.closedAt === undefined ? {} : { end: expectation.closedAt }),
  };
}

/**
 * A closure reclassified after the fact: `statusReason` says what it reads
 * as now; the extension keeps the reason it was closed with, and when and
 * by what it was reclassified (the closure's end stays the original one).
 */
function reclassificationExtension(expectation: Expectation): Extension[] {
  const { reclassification } = expectation;
  if (reclassification === undefined || expectation.closedReason === undefined) {
    return [];
  }
  return ext.complex(ENGINE_EXTENSIONS.closureReclassification, [
    ...ext.code('originalReason', expectation.closedReason),
    ...ext.dateTime('at', reclassification.at),
    ...ext.reference('by', referenceTo(reclassification.by)),
  ]);
}

export function expectationToTask(expectation: Expectation): Task {
  const closed = closure(expectation);
  const source = referenceTo(expectation.source);
  const extension: Extension[] = [
    ...ext.code(ENGINE_EXTENSIONS.layer, expectation.layer),
    ...ext.string(ENGINE_EXTENSIONS.ruleVersion, expectation.ruleVersion),
    ...ext.string(ENGINE_EXTENSIONS.protocolId, expectation.protocolId),
    ...ext.string(ENGINE_EXTENSIONS.protocolVersion, expectation.protocolVersion),
    ...ext.code(ENGINE_EXTENSIONS.origin, expectation.origin),
    ...ext.string(ENGINE_EXTENSIONS.matchKey, expectation.matchKey),
    ...evidenceExtension(expectation),
    ...reclassificationExtension(expectation),
    ...ext.string(ENGINE_EXTENSIONS.confirmedBy, expectation.confirmedBy),
    ...ext.dateTime(ENGINE_EXTENSIONS.confirmedAt, expectation.confirmedAt),
    ...ext.reference(
      ENGINE_EXTENSIONS.correctionOf,
      expectation.correctionOf === undefined ? undefined : taskReference(expectation.correctionOf),
    ),
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
    ...(closed.reason === undefined
      ? {}
      : { statusReason: concept(ENGINE_CODE_SYSTEMS.closedReason, closed.reason) }),
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
      ...(closed.end === undefined ? {} : { end: toFhirInstant(closed.end) }),
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
