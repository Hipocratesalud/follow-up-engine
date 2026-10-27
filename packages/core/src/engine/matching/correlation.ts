import {
  DEFAULT_BOOKING_TOLERANCE_DAYS,
  type EventCorrelation,
  type EventMatcher,
} from '../../config/common.ts';
import type { ClinicalEvent, PlanItemKind } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Coding } from '../../domain/resource.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { addDays } from '../support/time.ts';
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
  /**
   * Normalized specialties whose visits fulfill it: the protocol's, else the
   * specialty of the consultation that created it. Empty when unknown.
   */
  readonly specialties: ReadonlySet<string>;
  /** The practitioner of the consultation that created it, if known. */
  readonly practitionerId?: string;
}

export function toCorrelationTarget(
  expectation: Expectation,
  definition: ExpectationDefinition,
  timeline: PatientTimeline,
): CorrelationTarget {
  const code = parseCodeMatchKey(expectation.matchKey) ?? definition.code;
  const anchor = timeline.bySource(expectation.source);
  const anchorSpecialty = anchor === undefined ? undefined : timeline.specialtyOf(anchor);
  const specialties = (
    definition.specialties ?? (anchorSpecialty === undefined ? [] : [anchorSpecialty])
  )
    .map(normalizeSpecialty)
    .filter((specialty) => specialty !== '');
  const practitionerId = anchor === undefined ? undefined : timeline.practitionerOf(anchor);
  return {
    expectation,
    definition,
    kind: definition.expects ?? kindOfMatchKey(expectation.matchKey),
    ...(code === undefined ? {} : { code }),
    ...(anchor === undefined ? {} : { anchor }),
    specialties: new Set(specialties),
    ...(practitionerId === undefined ? {} : { practitionerId }),
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
    case 'record.withdrawn':
      return undefined;
  }
}

/** `Medicina Interna` and `medicina_interna` compare equal; accents and case do not matter. */
export function normalizeSpecialty(specialty: string | undefined): string {
  return (specialty ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Events that are a visit (done or booked). */
const VISIT_EVENTS: ReadonlySet<ClinicalEvent['type']> = new Set([
  'encounter.finished',
  'appointment.booked',
]);
/** Expectation kinds that ask for a visit with someone, so the specialty matters. */
const VISIT_KINDS: ReadonlySet<PlanItemKind> = new Set(['follow_up_visit', 'session']);

/**
 * Whether a visit is with the right people for a visit expectation: the same
 * practitioner, or one of `specialties`. Lenient when either side is
 * unknown (no specialty recorded), so hosts that send no specialty keep
 * working as before.
 */
export function visitSpecialtyFits(
  specialties: ReadonlySet<string>,
  practitionerId: string | undefined,
  event: ClinicalEvent,
  timeline: PatientTimeline,
): boolean {
  if (!VISIT_EVENTS.has(event.type) || specialties.size === 0) {
    return true;
  }
  if (practitionerId !== undefined && timeline.practitionerOf(event) === practitionerId) {
    return true;
  }
  const specialty = normalizeSpecialty(timeline.specialtyOf(event));
  return specialty === '' || specialties.has(specialty);
}

/**
 * A protocol's visit items only count visits of the protocol's specialties
 * (used to pick the visit that anchors the next one).
 */
export function definitionVisitFits(
  definition: ExpectationDefinition,
  event: ClinicalEvent,
  timeline: PatientTimeline,
): boolean {
  if (definition.specialties === undefined || !VISIT_KINDS.has(definition.expects ?? 'other')) {
    return true;
  }
  return visitSpecialtyFits(
    new Set(definition.specialties.map(normalizeSpecialty)),
    undefined,
    event,
    timeline,
  );
}

function visitFits(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  target: CorrelationTarget,
  timeline: PatientTimeline,
): boolean {
  if (!VISIT_KINDS.has(target.kind) || correlation.filter?.['specialty'] !== undefined) {
    return true;
  }
  return visitSpecialtyFits(target.specialties, target.practitionerId, event, timeline);
}

/**
 * A booking fulfills only when it brings the visit in on time: scheduled on
 * or before the due date (plus `toleranceDays`). Once the expectation is
 * overdue (the booking comes after the due date, usually because the team
 * called the patient), the appointment must fall within one normal window of
 * the booking (the time the expectation originally gave).
 */
function bookedInTime(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  target: CorrelationTarget,
): boolean {
  if (event.type !== 'appointment.booked') {
    return true;
  }
  const tolerance = correlation.toleranceDays ?? DEFAULT_BOOKING_TOLERANCE_DAYS;
  const due = target.expectation.dueAt;
  if (event.occurredAt.getTime() <= due.getTime()) {
    return event.scheduledFor.getTime() <= addDays(due, tolerance).getTime();
  }
  const anchorInstant =
    target.anchor === undefined ? target.expectation.createdAt : eventInstant(target.anchor);
  const window = Math.max(0, due.getTime() - anchorInstant.getTime());
  const deadline = Math.max(
    addDays(event.occurredAt, tolerance).getTime(),
    event.occurredAt.getTime() + window,
  );
  return event.scheduledFor.getTime() <= deadline;
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
      return (
        happensAfterAnchor(event, target) &&
        bookedInTime(correlation, event, target) &&
        visitFits(correlation, event, target, timeline)
      );
    case 'same_specialty':
      return (
        happensAfterAnchor(event, target) &&
        bookedInTime(correlation, event, target) &&
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
    case 'record.withdrawn':
      return `fulfilled_by_${event.type.replace('.', '_')}`;
  }
}
