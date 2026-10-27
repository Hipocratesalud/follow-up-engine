import type { EventCorrelation, EventMatcher } from '../../config/common.ts';
import type { ClinicalEvent, PlanItemKind } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Coding } from '../../domain/resource.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { encounterOf, eventInstant, type PatientTimeline, refKey } from '../timeline.ts';
import { matchesFilter } from './filter.ts';
import { kindOfMatchKey, parseCodeMatchKey, sameCoding } from './match-key.ts';

/** An expectation together with what is needed to decide which events close it. */
export interface CorrelationTarget {
  readonly expectation: Expectation;
  readonly definition: ExpectationDefinition;
  readonly kind: PlanItemKind;
  readonly code?: Coding;
  /** The event that created it (order, prescription, note, ...), when still in the record. */
  readonly anchor?: ClinicalEvent;
}

export function toCorrelationTarget(
  expectation: Expectation,
  definition: ExpectationDefinition,
  timeline: PatientTimeline,
): CorrelationTarget {
  const code = parseCodeMatchKey(expectation.matchKey) ?? definition.code;
  const anchor = timeline.bySource(expectation.source);
  return {
    expectation,
    definition,
    kind: definition.expects ?? kindOfMatchKey(expectation.matchKey),
    ...(code === undefined ? {} : { code }),
    ...(anchor === undefined ? {} : { anchor }),
  };
}

/** The terminology code an event carries, if any. */
export function codeOfEvent(event: ClinicalEvent): Coding | undefined {
  switch (event.type) {
    case 'service_request.created':
    case 'result.received':
    case 'condition.recorded':
      return event.code;
    case 'medication.prescribed':
      return event.medication.code;
    case 'encounter.finished':
    case 'appointment.booked':
    case 'appointment.cancelled':
    case 'note.received':
    case 'plan.extracted':
    case 'patient.opted_out':
      return undefined;
  }
}

function normalizeSpecialty(specialty: string | undefined): string {
  return (specialty ?? '').trim().toLowerCase();
}

/**
 * Whether the event comes after the expectation's trigger. A finished
 * encounter never fulfills an expectation created in that same encounter
 * (the consultation that ordered the test is not its follow-up).
 */
function happensAfterAnchor(event: ClinicalEvent, target: CorrelationTarget): boolean {
  const anchorInstant =
    target.anchor === undefined ? target.expectation.createdAt : eventInstant(target.anchor);
  if (eventInstant(event).getTime() <= anchorInstant.getTime()) {
    return false;
  }
  if (event.type === 'encounter.finished' && target.anchor !== undefined) {
    const anchorEncounter = encounterOf(target.anchor);
    return anchorEncounter === undefined || encounterOf(event) !== anchorEncounter;
  }
  return true;
}

function orderIdsOf(target: CorrelationTarget): readonly string[] {
  const ids: string[] = [];
  if (target.anchor?.type === 'service_request.created') {
    ids.push(target.anchor.orderId);
  }
  if (target.expectation.source.resourceType === 'ServiceRequest') {
    ids.push(target.expectation.source.id);
  }
  return ids;
}

/** Event type, filter and code checks of a correlation, without timing or anchors. */
export function matchesShape(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  code: Coding | undefined,
): boolean {
  if (event.type !== correlation.event || !matchesFilter(correlation.filter, event)) {
    return false;
  }
  if (correlation.match !== 'same_code' || code === undefined) {
    return true;
  }
  const eventCode = codeOfEvent(event);
  return eventCode !== undefined && sameCoding(eventCode, code);
}

/** Whether `event` relates to `target` the way `correlation` says (see `MATCH_STRATEGIES`). */
export function correlates(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  target: CorrelationTarget,
  timeline: PatientTimeline,
): boolean {
  if (correlation.forKinds !== undefined && !correlation.forKinds.includes(target.kind)) {
    return false;
  }
  if (!matchesShape(correlation, event, target.code)) {
    return false;
  }
  switch (correlation.match) {
    case 'same_order':
      return (
        event.type === 'result.received' &&
        event.basedOnOrderId !== undefined &&
        orderIdsOf(target).includes(event.basedOnOrderId)
      );
    case 'same_code':
    case 'any':
      return happensAfterAnchor(event, target);
    case 'same_specialty':
      return (
        happensAfterAnchor(event, target) &&
        (target.anchor === undefined ||
          normalizeSpecialty(timeline.specialtyOf(event)) ===
            normalizeSpecialty(timeline.specialtyOf(target.anchor)))
      );
  }
}

function excluded(matchers: readonly EventMatcher[], event: ClinicalEvent): boolean {
  return matchers.some(
    (matcher) => matcher.event === event.type && matchesFilter(matcher.filter, event),
  );
}

/** The correlation through which `event` fulfills the target, if it does. */
export function findFulfillment(
  event: ClinicalEvent,
  target: CorrelationTarget,
  timeline: PatientTimeline,
): EventCorrelation | undefined {
  if (excluded(target.definition.notFulfilledBy, event)) {
    return undefined;
  }
  return target.definition.fulfilledBy.find((correlation) =>
    correlates(correlation, event, target, timeline),
  );
}

/** Whether `event` replaces the target (for example a newer order of the same test). */
export function supersedes(
  event: ClinicalEvent,
  target: CorrelationTarget,
  timeline: PatientTimeline,
): boolean {
  return (
    refKey(event.source) !== refKey(target.expectation.source) &&
    target.definition.supersededBy.some((correlation) =>
      correlates(correlation, event, target, timeline),
    )
  );
}

/** Machine code of a fulfillment, for `Expectation.closedReason`. */
export function fulfillmentReason(event: ClinicalEvent): string {
  switch (event.type) {
    case 'result.received':
      return 'fulfilled_by_result';
    case 'encounter.finished':
      return 'fulfilled_by_encounter';
    case 'appointment.booked':
      return 'fulfilled_by_appointment';
    case 'appointment.cancelled':
    case 'service_request.created':
    case 'medication.prescribed':
    case 'condition.recorded':
    case 'note.received':
    case 'plan.extracted':
    case 'patient.opted_out':
      return `fulfilled_by_${event.type.replace('.', '_')}`;
  }
}
