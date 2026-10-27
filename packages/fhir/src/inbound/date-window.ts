import { toFhirInstant } from '../support/datetime.ts';
import type { EntryContext, EventDraft } from './context.ts';

const MS_PER_DAY = 86_400_000;

/**
 * Dates the engine accepts at all, whatever the receipt time: a clinical
 * date before 1900 or after 2200 is a typo in the host (year 9999), and due
 * dates computed from it would not even be valid FHIR (`+010000-01-09`).
 */
export const CLINICAL_DATE_RANGE = {
  from: new Date('1900-01-01T00:00:00Z'),
  to: new Date('2200-01-01T00:00:00Z'),
} as const;

/** Against the real receipt time (live ingestion): */
export const FUTURE_DATE_LIMITS = {
  /** Dated more than this after receipt: a warning (host clock, time zones). */
  warnAfterDays: 1,
  /** Dated more than this after receipt: an error. */
  rejectAfterDays: 366,
  /** Scheduled dates (an appointment) may be this far ahead. */
  scheduledRejectAfterDays: 5 * 366,
} as const;

/**
 * Against the real receipt time: an event that starts follow-up (a visit, an
 * order, a prescription, a result, a note) dated more than this before
 * receipt is old history sent live: a warning. The engine never contacts the
 * patient about it by itself and holds what is too old among the patients to
 * recover (`EngineSettings.lateHistoryDays`, same default).
 */
export const PAST_DATE_LIMITS = {
  warnBeforeDays: 90,
} as const;

/** Events whose date starts follow-up (a diagnosis or a withdrawal may be old on purpose). */
const FOLLOW_UP_EVENT_TYPES: ReadonlySet<string> = new Set([
  'encounter.finished',
  'service_request.created',
  'medication.prescribed',
  'result.received',
  'note.received',
]);

/** Fields that say when something happened (the rest, like `scheduledFor`, may be ahead). */
const HAPPENED_AT_FIELDS: ReadonlySet<string> = new Set(['occurredAt', 'authoredAt']);

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Sanity window for the dates a resource maps to, reported once per entry.
 * Outside {@link CLINICAL_DATE_RANGE} is always an error. With
 * `againstReceipt` (`receivedAt` is the real time the host sent it), an event
 * dated more than a year after receipt is an error and more than a day after
 * a warning; scheduled dates may be up to five years ahead; a visit, order,
 * prescription, result or note dated more than 90 days before receipt is a
 * warning (old history sent live).
 */
export function checkEventDates(
  events: readonly EventDraft[],
  ctx: EntryContext,
  againstReceipt: boolean,
): void {
  const received = ctx.receivedAt.getTime();
  let error: string | undefined;
  let warning: string | undefined;
  for (const event of events) {
    for (const [field, value] of Object.entries(event)) {
      if (!isDate(value)) {
        continue;
      }
      const time = value.getTime();
      const happened = HAPPENED_AT_FIELDS.has(field);
      const label = `${event.type} ${field} ${toFhirInstant(value)}`;
      const rejectAfter = happened
        ? FUTURE_DATE_LIMITS.rejectAfterDays
        : FUTURE_DATE_LIMITS.scheduledRejectAfterDays;
      if (time < CLINICAL_DATE_RANGE.from.getTime() || time >= CLINICAL_DATE_RANGE.to.getTime()) {
        error ??= `${label} is outside the accepted range (1900 to 2200); check the date`;
      } else if (againstReceipt && time > received + rejectAfter * MS_PER_DAY) {
        error ??= `${label} is more than ${happened ? 'a year' : 'five years'} after the engine received it (${toFhirInstant(ctx.receivedAt)}); check the date`;
      } else if (
        againstReceipt &&
        happened &&
        time > received + FUTURE_DATE_LIMITS.warnAfterDays * MS_PER_DAY
      ) {
        warning ??= `${label} is in the future (received ${toFhirInstant(ctx.receivedAt)}); check the host clock`;
      } else if (
        againstReceipt &&
        field === 'occurredAt' &&
        FOLLOW_UP_EVENT_TYPES.has(event.type) &&
        time < received - PAST_DATE_LIMITS.warnBeforeDays * MS_PER_DAY
      ) {
        warning ??= `${label} is more than ${String(PAST_DATE_LIMITS.warnBeforeDays)} days before the engine received it (${toFhirInstant(ctx.receivedAt)}); old history belongs in the backfill import: its overdue follow-up never contacts the patient automatically and, beyond the clinic's notify window, waits among the patients to recover`;
      }
    }
  }
  if (error !== undefined) {
    ctx.report('error', 'value', error);
  } else if (warning !== undefined) {
    ctx.report('warning', 'value', warning);
  }
}
