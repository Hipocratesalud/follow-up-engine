import type {
  ClinicalEvent,
  DomainEvent,
  PlanItem,
  ResultReceivedEvent,
} from '@follow-up-engine/core';

/**
 * `jsonb` stores dates as ISO 8601 strings. These decoders turn a stored
 * event back into its typed form by reviving exactly the fields the domain
 * declares as `Date`. The switches are exhaustive, so a new event type that
 * is not handled here fails to compile.
 */

/** The JSON form of a domain object: what `JSON.parse(JSON.stringify(value))` yields. */
type Stored<T> = { readonly [K in keyof T]: unknown };

/** Raised when a stored value is not a valid ISO 8601 instant. */
export class CorruptRowError extends Error {
  override readonly name = 'CorruptRowError';
}

export function reviveDate(value: unknown, field: string): Date {
  if (typeof value === 'string' || value instanceof Date) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new CorruptRowError(`Stored field ${field} is not a valid instant`);
}

function reviveOptionalDate(value: unknown, field: string): Date | undefined {
  return value === undefined || value === null ? undefined : reviveDate(value, field);
}

/** The stored event with `recordedAt` (when the host recorded its source's version) revived. */
function withRecordedAt(payload: Stored<ClinicalEvent>): ClinicalEvent {
  const event = payload as ClinicalEvent;
  const recordedAt = reviveOptionalDate(payload.recordedAt, 'recordedAt');
  return recordedAt === undefined ? event : { ...event, recordedAt };
}

function revivePlanItems(items: unknown): PlanItem[] {
  if (!Array.isArray(items)) {
    throw new CorruptRowError('Stored plan.extracted items is not an array');
  }
  return items.map((item: Stored<PlanItem>, index) => ({
    ...(item as PlanItem),
    dueAt: reviveDate(item.dueAt, `items[${String(index)}].dueAt`),
  }));
}

/** Decodes a `clinical_events.payload` value. */
export function decodeClinicalEvent(payload: Stored<ClinicalEvent>): ClinicalEvent {
  const event = withRecordedAt(payload);
  const occurredAt = reviveDate(payload.occurredAt, 'occurredAt');
  switch (event.type) {
    case 'result.received': {
      const valueDate = reviveOptionalDate(
        (payload as Stored<ResultReceivedEvent>).valueDate,
        'valueDate',
      );
      return valueDate === undefined
        ? { ...event, occurredAt }
        : { ...event, occurredAt, valueDate };
    }
    case 'encounter.finished':
    case 'service_request.created':
    case 'condition.recorded':
    case 'patient.opted_out':
    case 'patient.language_recorded':
    case 'record.withdrawn':
      return { ...event, occurredAt };
    case 'appointment.booked':
    case 'appointment.cancelled':
      return { ...event, occurredAt, scheduledFor: reviveDate(event.scheduledFor, 'scheduledFor') };
    case 'medication.prescribed':
      return { ...event, occurredAt, startAt: reviveDate(event.startAt, 'startAt') };
    case 'note.received':
      return { ...event, occurredAt, authoredAt: reviveDate(event.authoredAt, 'authoredAt') };
    case 'plan.extracted':
      return { ...event, occurredAt, items: revivePlanItems(event.items) };
  }
}

/** Decodes an `outbox.event` value. */
export function decodeDomainEvent(stored: Stored<DomainEvent>): DomainEvent {
  const event = stored as DomainEvent;
  const occurredAt = reviveDate(stored.occurredAt, 'occurredAt');
  switch (event.type) {
    case 'case.opened':
    case 'case.escalated':
    case 'case.resolved':
    case 'backfill.completed':
    case 'backfill.paused':
    case 'contact.outcome_recorded':
    case 'clinical_finding.created':
      return { ...event, occurredAt };
    case 'patient_contact.requested': {
      const { dueBy, ...rest } = event.payload;
      const revived = reviveOptionalDate(dueBy, 'payload.dueBy');
      return {
        ...event,
        occurredAt,
        payload: revived === undefined ? rest : { ...rest, dueBy: revived },
      };
    }
  }
}
