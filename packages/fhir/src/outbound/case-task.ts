import type { CaseStatus, FollowUpCase } from '@follow-up-engine/core';
import type { Extension, Task } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { CASE_TASK_CODE, ENGINE_CODE_SYSTEMS, ENGINE_EXTENSIONS } from '../terminology.ts';
import { concept, ext, hostUserReference, patientReference, taskReference } from './elements.ts';

/** FHIR `Task.status` for each case status; the exact engine status goes in `businessStatus`. */
export const CASE_TASK_STATUS = {
  open: 'ready',
  notified: 'ready',
  snoozed: 'on-hold',
  escalated: 'in-progress',
  resolved: 'completed',
  dismissed: 'cancelled',
  lost_to_follow_up: 'failed',
} as const satisfies Record<CaseStatus, Task['status']>;

export type TaskPriority = NonNullable<Task['priority']>;

/**
 * Lower bounds of the engine's numeric priority for each FHIR `Task.priority`
 * (checked from the most urgent down). Below `urgent` the case is `routine`.
 * The raw number also travels in the priority-score extension.
 */
export const CASE_PRIORITY_THRESHOLDS = {
  stat: 90,
  asap: 75,
  urgent: 60,
} as const satisfies Partial<Record<TaskPriority, number>>;

/** FHIR `Task.priority` of an engine priority (higher is more urgent). */
export function taskPriority(priority: number): TaskPriority {
  if (priority >= CASE_PRIORITY_THRESHOLDS.stat) {
    return 'stat';
  }
  if (priority >= CASE_PRIORITY_THRESHOLDS.asap) {
    return 'asap';
  }
  return priority >= CASE_PRIORITY_THRESHOLDS.urgent ? 'urgent' : 'routine';
}

function resolutionExtension(followUpCase: FollowUpCase): Extension[] {
  const { resolution } = followUpCase;
  if (resolution === undefined) {
    return [];
  }
  return ext.complex(ENGINE_EXTENSIONS.resolution, [
    { url: 'kind', valueCode: resolution.kind },
    { url: 'resolvedAt', valueDateTime: toFhirInstant(resolution.resolvedAt) },
    ...ext.string('resolvedBy', resolution.resolvedBy),
    ...ext.string('note', resolution.note),
    ...ext.code('dismissReason', resolution.dismissReason),
  ]);
}

/**
 * `Task.statusReason` of a closed case: why the team dismissed it (a
 * `cancelled` Task, in the dismiss-reason CodeSystem), else how it resolved.
 */
function statusReason(followUpCase: FollowUpCase): Task['statusReason'] {
  const { resolution } = followUpCase;
  if (resolution === undefined) {
    return undefined;
  }
  return resolution.dismissReason === undefined
    ? concept(ENGINE_CODE_SYSTEMS.caseResolution, resolution.kind)
    : concept(ENGINE_CODE_SYSTEMS.dismissReason, resolution.dismissReason);
}

/**
 * A follow-up case as a FHIR `Task` (code `follow-up-case`, intent
 * `proposal`: the engine suggests, the clinic decides).
 *
 * - `status`: {@link CASE_TASK_STATUS}; `businessStatus`: the exact engine status.
 * - `priority`: {@link taskPriority}; `owner`: the assignee (host user).
 * - `input`: one entry per reason, typed by the reason code, pointing at the expectation Task.
 */
export function caseToTask(followUpCase: FollowUpCase): Task {
  const extension: Extension[] = [
    ...ext.integer(ENGINE_EXTENSIONS.escalationStep, followUpCase.escalationStep),
    ...ext.integer(ENGINE_EXTENSIONS.priorityScore, followUpCase.priority),
    ...ext.string(ENGINE_EXTENSIONS.dedupKey, followUpCase.dedupKey),
    ...ext.code(ENGINE_EXTENSIONS.origin, followUpCase.origin),
    ...ext.dateTime(ENGINE_EXTENSIONS.releaseAt, followUpCase.releaseAt),
    ...ext.dateTime(ENGINE_EXTENSIONS.nextActionAt, followUpCase.nextActionAt),
    ...ext.dateTime(ENGINE_EXTENSIONS.snoozedUntil, followUpCase.snoozedUntil),
    ...ext.string(ENGINE_EXTENSIONS.escalationPolicy, followUpCase.escalationPolicyId),
    ...resolutionExtension(followUpCase),
  ];
  const { resolution } = followUpCase;
  return {
    resourceType: 'Task',
    id: toFhirId(followUpCase.id),
    extension,
    status: CASE_TASK_STATUS[followUpCase.status],
    ...(resolution === undefined ? {} : { statusReason: statusReason(followUpCase) }),
    businessStatus: concept(
      ENGINE_CODE_SYSTEMS.caseStatus,
      followUpCase.status,
      followUpCase.status,
    ),
    intent: 'proposal',
    priority: taskPriority(followUpCase.priority),
    code: {
      coding: [
        { system: ENGINE_CODE_SYSTEMS.taskType, code: CASE_TASK_CODE, display: 'Follow-up case' },
      ],
    },
    for: patientReference(followUpCase.patientId),
    executionPeriod: {
      start: toFhirInstant(followUpCase.createdAt),
      ...(resolution === undefined ? {} : { end: toFhirInstant(resolution.resolvedAt) }),
    },
    authoredOn: toFhirInstant(followUpCase.createdAt),
    lastModified: toFhirInstant(followUpCase.updatedAt),
    ...(followUpCase.assignee === undefined
      ? {}
      : { owner: hostUserReference(followUpCase.assignee) }),
    ...(followUpCase.reasons.length === 0
      ? {}
      : {
          input: followUpCase.reasons.map((reason) => ({
            type: concept(ENGINE_CODE_SYSTEMS.reason, reason.reasonCode),
            valueReference: taskReference(reason.expectationId),
          })),
        }),
  };
}
