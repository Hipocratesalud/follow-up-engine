import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { recordAttendance } from '../attribution/attribution.ts';
import { reopened } from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import {
  type CorrelationTarget,
  findFulfillment,
  fulfillmentReason,
  toCorrelationTarget,
} from '../matching/correlation.ts';
import { addDays } from '../support/time.ts';
import { type PatientTimeline, refKey } from '../timeline.ts';

/** What re-deciding a fulfilled expectation against the record did. */
export type RecheckOutcome =
  | { readonly kind: 'kept' }
  /** Still fulfilled, now by another event (the visit of a booking kept, a booking made again). */
  | { readonly kind: 'refulfilled'; readonly expectation: Expectation }
  /** Nothing in the record fulfills it any more: open again. */
  | { readonly kind: 'reopened'; readonly expectation: Expectation };

/** Fulfilled by a booking: when to check the visit took place (its date plus the grace days). */
export function recheckAtFor(event: ClinicalEvent, graceDays: number): Date | undefined {
  return event.type === 'appointment.booked' ? addDays(event.scheduledFor, graceDays) : undefined;
}

/**
 * The event of the record that fulfills `target` now: a visit or a result
 * before a booking (the visit is what the booking promised), else the
 * latest booking still pending.
 */
export function currentFulfillment(
  target: CorrelationTarget,
  timeline: PatientTimeline,
): ClinicalEvent | undefined {
  const fulfilling = timeline.events.filter(
    (event) => findFulfillment(event, target, timeline) !== undefined,
  );
  return fulfilling.find((event) => event.type !== 'appointment.booked') ?? fulfilling.at(-1);
}

/**
 * Re-decides a fulfilled expectation against the record as of `now`: what
 * fulfilled it may no longer stand (a booking cancelled, rescheduled past
 * the due date, or whose date passed with no visit; a visit or result
 * withdrawn). Still fulfilled by something else: it records that event (a
 * booking kept is now fulfilled by its visit). Fulfilled by nothing: it is
 * open again, out of its former case; already due, the next watcher run
 * expires it into a case.
 */
export async function recheckFulfilled(input: {
  readonly stores: TransactionalStores;
  readonly catalog: Catalog;
  readonly timeline: PatientTimeline;
  readonly expectation: Expectation;
  readonly now: Date;
  readonly graceDays: number;
}): Promise<RecheckOutcome> {
  const { stores, expectation, now, graceDays } = input;
  const definition = input.catalog.definition(expectation.ruleId);
  if (definition === undefined || expectation.status !== 'fulfilled') {
    return { kind: 'kept' };
  }
  const target = toCorrelationTarget(expectation, definition, input.timeline, {
    now,
    bookingGraceDays: graceDays,
  });
  const event = currentFulfillment(target, input.timeline);
  if (event === undefined) {
    const open = reopened(expectation, now);
    await stores.expectations.update(expectation.clinicId, open);
    return { kind: 'reopened', expectation: open };
  }
  const recheckAt = recheckAtFor(event, graceDays);
  if (
    expectation.closedBy !== undefined &&
    refKey(expectation.closedBy) === refKey(event.source) &&
    expectation.recheckAt?.getTime() === recheckAt?.getTime()
  ) {
    return { kind: 'kept' };
  }
  const next: { -readonly [K in keyof Expectation]: Expectation[K] } = {
    ...expectation,
    closedReason: fulfillmentReason(event),
    closedBy: event.source,
    updatedAt: now,
  };
  if (recheckAt === undefined) {
    delete next.recheckAt;
  } else {
    next.recheckAt = recheckAt;
  }
  await stores.expectations.update(expectation.clinicId, next);
  // A booking kept: its visit fulfills it now (HIP-141 attended metrics).
  await recordAttendance({
    stores,
    expectation: next,
    previous: expectation.closedBy,
    event,
    timeline: input.timeline,
    now,
  });
  return { kind: 'refulfilled', expectation: next };
}
