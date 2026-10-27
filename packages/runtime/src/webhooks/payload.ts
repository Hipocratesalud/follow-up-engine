import {
  type BackfillCounts,
  type DomainEvent,
  RECONCILIATION_REPAIR_KINDS,
  type ReconciliationCounts,
} from '@follow-up-engine/core';

/** JSON body of a webhook. Ids, codes and dates only: never a diagnosis, a test name or note text. */
export interface WebhookBody {
  /** The domain event id; also sent as `X-FollowUp-Delivery`. Deduplicate on it. */
  readonly id: string;
  readonly type: DomainEvent['type'];
  readonly clinicId: string;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

function caseLink(caseId: string): string {
  return `Task/${caseId}`;
}

function requestLink(requestId: string): string {
  return `CommunicationRequest/${requestId}`;
}

/** The counters of a backfill run (counts and a cost: nothing about any patient). */
function backfillCounts(counts: BackfillCounts): Record<keyof BackfillCounts, number> {
  return {
    patientsScanned: counts.patientsScanned,
    eventsProcessed: counts.eventsProcessed,
    documentsProcessed: counts.documentsProcessed,
    expectationsCreated: counts.expectationsCreated,
    expectationsFulfilled: counts.expectationsFulfilled,
    casesOpened: counts.casesOpened,
    llmCostUsd: counts.llmCostUsd,
  };
}

/** `expectation_created` → `expectationCreated`. */
function camel(kind: string): string {
  return kind.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * The counters of a reconciliation run: patients and repairs, with one key
 * per repair kind (`expectationCreated`, `caseResolved`, ...; 0 when none).
 */
function reconciliationCounts(counts: ReconciliationCounts): Record<string, number> {
  return {
    patientsScanned: counts.patientsScanned,
    patientsRepaired: counts.patientsRepaired,
    patientsSkipped: counts.patientsSkipped,
    repairs: counts.repairs,
    ...Object.fromEntries(
      RECONCILIATION_REPAIR_KINDS.map((kind) => [camel(kind), counts.repairsByKind[kind] ?? 0]),
    ),
  };
}

/**
 * Builds the webhook body of a domain event. Payloads are deliberately thin:
 * reason codes and labels can name a condition (`protocol_diabetes_hba1c`),
 * so they are left out; the host fetches the details it needs from
 * `GET /fhir/Task/<caseId>` with its API key.
 */
export function toWebhookBody(event: DomainEvent): WebhookBody {
  const base = {
    id: event.id,
    type: event.type,
    clinicId: event.clinicId,
    occurredAt: event.occurredAt.toISOString(),
  };
  switch (event.type) {
    case 'case.opened':
      return {
        ...base,
        data: {
          caseId: event.payload.caseId,
          patientId: event.payload.patientId,
          priority: event.payload.priority,
          origin: event.payload.origin,
          reasonCount: event.payload.reasons.length,
          task: caseLink(event.payload.caseId),
        },
      };
    case 'case.escalated':
      return {
        ...base,
        data: {
          caseId: event.payload.caseId,
          patientId: event.payload.patientId,
          escalationStep: event.payload.escalationStep,
          priority: event.payload.priority,
          task: caseLink(event.payload.caseId),
        },
      };
    case 'case.resolved':
      return {
        ...base,
        data: {
          caseId: event.payload.caseId,
          patientId: event.payload.patientId,
          resolution: event.payload.resolution,
          task: caseLink(event.payload.caseId),
        },
      };
    case 'patient_contact.requested':
      return {
        ...base,
        data: {
          caseId: event.payload.caseId,
          patientId: event.payload.patientId,
          purpose: event.payload.purpose,
          dueBy: event.payload.dueBy?.toISOString() ?? null,
          ...(event.payload.channel === undefined ? {} : { channel: event.payload.channel }),
          ...(event.payload.attempt === undefined ? {} : { attempt: event.payload.attempt }),
          task: caseLink(event.payload.caseId),
          ...(event.payload.requestId === undefined
            ? {}
            : { communicationRequest: requestLink(event.payload.requestId) }),
        },
      };
    case 'contact.outcome_recorded':
      return {
        ...base,
        data: {
          caseId: event.payload.caseId,
          patientId: event.payload.patientId,
          outcome: event.payload.outcome,
          ...(event.payload.channel === undefined ? {} : { channel: event.payload.channel }),
          task: caseLink(event.payload.caseId),
          communicationRequest: requestLink(event.payload.requestId),
          communication: `Communication/${event.payload.communicationId}`,
        },
      };
    case 'backfill.completed':
      return {
        ...base,
        data: {
          runId: event.payload.runId,
          shadow: event.payload.shadow,
          ...backfillCounts(event.payload),
          casesScheduled: event.payload.casesScheduled,
          casesNotNotified: event.payload.casesNotNotified,
        },
      };
    case 'backfill.paused':
      return {
        ...base,
        data: {
          runId: event.payload.runId,
          reason: event.payload.reason,
          ...backfillCounts(event.payload),
        },
      };
    case 'reconciliation.completed':
    case 'reconciliation.repairs_found':
      return {
        ...base,
        data: {
          runId: event.payload.runId,
          scope: event.payload.scope,
          ...reconciliationCounts(event.payload),
        },
      };
    case 'clinical_finding.created':
      return {
        ...base,
        data: {
          findingId: event.payload.findingId,
          patientId: event.payload.patientId,
          severity: event.payload.severity,
          detectedIssue: `DetectedIssue/${event.payload.findingId}`,
        },
      };
  }
}
