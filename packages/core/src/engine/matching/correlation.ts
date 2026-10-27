import {
  DEFAULT_BOOKING_TOLERANCE_DAYS,
  DEFAULT_BOOKING_TOLERANCE_FRACTION,
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
import { currentDating, gestationalAgeAt } from '../protocols/gestational-age.ts';
import { resultAnswers, sameConcept } from '../terminology/loinc.ts';
import { type TestGroup, testGroupOfCoding, testGroupsNamedIn } from '../terminology/test-names.ts';
import { kindOfMatchKey, parseCodeMatchKey } from './match-key.ts';
import { canonicalSpecialty, referredSpecialties } from './specialty.ts';

const MS_PER_DAY = 86_400_000;

/**
 * When the engine decides (its "now") and how many days after a booked
 * date a visit may still be recorded: past that, a booking with no visit no
 * longer fulfills anything (the patient did not come, whatever the host
 * says about the Appointment). Without `now`, bookings never lapse.
 */
export interface MatchContext {
  readonly now?: Date;
  readonly bookingGraceDays?: number;
}

/** An expectation together with what is needed to decide which events close it. */
export interface CorrelationTarget {
  readonly expectation: Expectation;
  readonly definition: ExpectationDefinition;
  readonly kind: PlanItemKind;
  readonly code?: Coding;
  /**
   * For a lab or imaging expectation with no code (a doctor's-plan item the
   * extraction could not code): the tests its quote names. Only a result of
   * one of them can fulfill it (see {@link matchesShape}).
   */
  readonly namedTests?: readonly TestGroup[];
  /** The event that created it (order, prescription, note, ...), when still in the record. */
  readonly anchor?: ClinicalEvent;
  /**
   * Normalized specialties whose visits fulfill it: the protocol's, else the
   * specialty of the consultation that created it. Empty when unknown.
   */
  readonly specialties: ReadonlySet<string>;
  /** The practitioner of the consultation that created it, if known. */
  readonly practitionerId?: string;
  readonly context: MatchContext;
}

/**
 * The specialties a visit expectation asks for. A doctor's-plan item that
 * names another specialty than its author's ("control con cardiología en 1
 * mes" written by internal medicine) is a referral: only a visit of the
 * named specialty fulfills it, and the author's own practitioner does not.
 * Otherwise the protocol's specialties, else the author's.
 */
function visitSpecialties(
  expectation: Expectation,
  definition: ExpectationDefinition,
  kind: PlanItemKind,
  anchorSpecialty: string | undefined,
  timeline: PatientTimeline,
): { readonly specialties: readonly string[]; readonly referral: boolean } {
  if (definition.layer === 'doctor_plan' && VISIT_KINDS.has(kind)) {
    const named = referredSpecialties(expectation, timeline);
    const author = normalizeSpecialty(anchorSpecialty);
    if (named.size > 0 && !named.has(author)) {
      return { specialties: [...named], referral: true };
    }
  }
  const specialties = (
    definition.specialties ?? (anchorSpecialty === undefined ? [] : [anchorSpecialty])
  )
    .map(normalizeSpecialty)
    .filter((specialty) => specialty !== '');
  return { specialties, referral: false };
}

export function toCorrelationTarget(
  expectation: Expectation,
  definition: ExpectationDefinition,
  timeline: PatientTimeline,
  context: MatchContext = {},
): CorrelationTarget {
  const code = parseCodeMatchKey(expectation.matchKey) ?? definition.code;
  const anchor = timeline.bySource(expectation.source);
  const anchorSpecialty = anchor === undefined ? undefined : timeline.specialtyOf(anchor);
  const kind = definition.expects ?? kindOfMatchKey(expectation.matchKey);
  const { specialties, referral } = visitSpecialties(
    expectation,
    definition,
    kind,
    anchorSpecialty,
    timeline,
  );
  const practitionerId =
    anchor === undefined || referral ? undefined : timeline.practitionerOf(anchor);
  const namedTests =
    code === undefined && TEST_KINDS.has(kind)
      ? testGroupsNamedIn(expectation.evidence?.quote ?? '')
      : undefined;
  return {
    expectation,
    definition,
    kind,
    ...(code === undefined ? {} : { code }),
    ...(namedTests === undefined ? {} : { namedTests }),
    ...(anchor === undefined ? {} : { anchor }),
    specialties: new Set(specialties),
    ...(practitionerId === undefined ? {} : { practitionerId }),
    context,
  };
}

/** The terminology code an event carries, if any. */
export function codeOfEvent(event: ClinicalEvent): Coding | undefined {
  switch (event.type) {
    case 'service_request.created':
    case 'result.received':
    case 'condition.recorded':
    case 'allergy.recorded':
      return event.code;
    case 'medication.prescribed':
      return event.medication.code;
    case 'encounter.finished':
    case 'appointment.booked':
    case 'appointment.cancelled':
    case 'note.received':
    case 'plan.extracted':
    case 'patient.opted_out':
    case 'patient.language_recorded':
    case 'record.withdrawn':
      return undefined;
  }
}

/**
 * `Medicina Interna`, `medicina_interna` and `internal_medicine` compare
 * equal; accents and case do not matter (see `canonicalSpecialty`).
 */
export function normalizeSpecialty(specialty: string | undefined): string {
  return canonicalSpecialty(specialty);
}

/** Events that are a visit (done or booked). */
const VISIT_EVENTS: ReadonlySet<ClinicalEvent['type']> = new Set([
  'encounter.finished',
  'appointment.booked',
]);
/** Expectation kinds that ask for a test result. */
const TEST_KINDS: ReadonlySet<PlanItemKind> = new Set(['lab', 'imaging']);
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
 * Days a booking may fall after the due date and still count: the
 * correlation's `toleranceDays` (3 by default) or a share of the interval
 * the expectation gave (`toleranceFraction`, 15 % by default), whichever is
 * larger, so "control en 3 meses" booked two weeks late is the plan being
 * followed while a 14-day control keeps 3 days. A follow-up of a critical
 * result has none.
 */
export function bookingToleranceDays(
  correlation: EventCorrelation,
  target: CorrelationTarget,
): number {
  if (target.expectation.severity === 'critical') {
    return 0;
  }
  const floor = correlation.toleranceDays ?? DEFAULT_BOOKING_TOLERANCE_DAYS;
  const fraction = correlation.toleranceFraction ?? DEFAULT_BOOKING_TOLERANCE_FRACTION;
  const intervalDays = intervalOf(target) / MS_PER_DAY;
  return Math.max(floor, Math.ceil(intervalDays * fraction));
}

/** The time the expectation originally gave: from its trigger to its due date. */
function intervalOf(target: CorrelationTarget): number {
  const anchorInstant =
    target.anchor === undefined ? target.expectation.createdAt : eventInstant(target.anchor);
  return Math.max(0, target.expectation.dueAt.getTime() - anchorInstant.getTime());
}

/** Whether a booking's date passed (plus the grace days) as of the target's `now`. */
export function bookingLapsed(
  event: Extract<ClinicalEvent, { type: 'appointment.booked' }>,
  context: MatchContext,
): boolean {
  return (
    context.now !== undefined &&
    addDays(event.scheduledFor, context.bookingGraceDays ?? 0).getTime() <= context.now.getTime()
  );
}

/**
 * A booking fulfills only when it brings the visit in on time: scheduled on
 * or before the due date plus the tolerance ({@link bookingToleranceDays}).
 * Once the expectation is overdue (the booking comes after the due date,
 * usually because the team called the patient), the appointment must fall
 * within one normal window of the booking (the time the expectation
 * originally gave). A booking whose date passed with no visit fulfills
 * nothing: the visit itself would.
 */
function bookedInTime(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  target: CorrelationTarget,
): boolean {
  if (event.type !== 'appointment.booked') {
    return true;
  }
  if (bookingLapsed(event, target.context)) {
    return false;
  }
  const tolerance = bookingToleranceDays(correlation, target);
  const due = target.expectation.dueAt;
  if (event.occurredAt.getTime() <= due.getTime()) {
    return event.scheduledFor.getTime() <= addDays(due, tolerance).getTime();
  }
  const deadline = Math.max(
    addDays(event.occurredAt, tolerance).getTime(),
    event.occurredAt.getTime() + intervalOf(target),
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

/**
 * Whether the event falls in the correlation's window (`earliestDaysBeforeDue`):
 * a visit, or the date a booking brings the visit in, no earlier than that
 * many days before the due date.
 */
export function withinFulfillmentWindow(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  dueAt: Date,
): boolean {
  if (correlation.earliestDaysBeforeDue === undefined) {
    return true;
  }
  const at = event.type === 'appointment.booked' ? event.scheduledFor : eventInstant(event);
  return at.getTime() >= addDays(dueAt, -correlation.earliestDaysBeforeDue).getTime();
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

/**
 * Whether a result answers an uncoded test expectation: it must be a test
 * its quote names ("se solicita creatinina" waits for a creatinine, never
 * for the fundus report or an HbA1c that arrive first). A quote that names
 * several tests ("pendiente HbA1c y creatinina") does not say which one the
 * item is, so no single result closes it; one that names none ("control con
 * laboratorios") is answered by a known test of its kind. A result of a
 * test the lexicon does not know never closes it: the item stays open for
 * the clinic to review rather than being closed by any result.
 */
function answersNamedTest(
  event: ClinicalEvent,
  namedTests: readonly TestGroup[],
  kind: PlanItemKind | undefined,
): boolean {
  const eventCode = codeOfEvent(event);
  const group =
    (eventCode === undefined ? undefined : testGroupOfCoding(eventCode)) ??
    testGroupsNamedIn(eventCode?.display ?? '')[0];
  if (group === undefined) {
    return false;
  }
  if (namedTests.length === 0) {
    return kind === undefined || group.kind === kind;
  }
  return namedTests.length === 1 && namedTests[0]?.id === group.id;
}

/**
 * Event type, filter and code checks of a correlation, without timing or
 * anchors. `same_code` with no code: an uncoded test (`namedTests` given)
 * is answered only by a result of the test its quote names; anything else
 * uncoded matches on type and filter alone.
 */
export function matchesShape(
  correlation: EventCorrelation,
  event: ClinicalEvent,
  code: Coding | undefined,
  namedTests?: readonly TestGroup[],
  kind?: PlanItemKind,
): boolean {
  if (event.type !== correlation.event || !matchesFilter(correlation.filter, event)) {
    return false;
  }
  if (correlation.match !== 'same_code') {
    return true;
  }
  if (code === undefined) {
    return (
      namedTests === undefined ||
      event.type !== 'result.received' ||
      answersNamedTest(event, namedTests, kind)
    );
  }
  const eventCode = codeOfEvent(event);
  if (eventCode === undefined) {
    return false;
  }
  // A result answers the request under any equivalent LOINC code (a lipid
  // panel by its components); a new order replaces one of the same measurement.
  return event.type === 'result.received'
    ? resultAnswers(eventCode, code)
    : sameConcept(eventCode, code);
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
  if (!matchesShape(correlation, event, target.code, target.namedTests, target.kind)) {
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
        withinFulfillmentWindow(correlation, event, target.expectation.dueAt) &&
        bookedInTime(correlation, event, target) &&
        visitFits(correlation, event, target, timeline)
      );
    case 'same_specialty':
      return (
        happensAfterAnchor(event, target) &&
        withinFulfillmentWindow(correlation, event, target.expectation.dueAt) &&
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

/** Weeks of gestation at which the second and third trimesters start. */
const TRIMESTER_STARTS = [14, 28] as const;

function trimesterOf(weeks: number): number {
  return TRIMESTER_STARTS.filter((start) => weeks >= start).length + 1;
}

/**
 * Whether two orders of the same test fall in different trimesters of a
 * dated pregnancy: prenatal tests are repeated by trimester (the 20-week
 * anatomy scan and the 32-week growth scan, a first- and a third-trimester
 * blood count), so the later one is a new test, not a re-order.
 */
function differentTrimesters(
  later: ClinicalEvent,
  earlier: ClinicalEvent | undefined,
  timeline: PatientTimeline,
): boolean {
  if (later.type !== 'service_request.created' || earlier?.type !== 'service_request.created') {
    return false;
  }
  const dating = currentDating(
    timeline.events.filter((event) => event.occurredAt.getTime() <= later.occurredAt.getTime()),
  );
  if (dating === undefined) {
    return false;
  }
  const weeks = [earlier, later].map(
    (order) => gestationalAgeAt(dating, order.occurredAt).totalDays / 7,
  );
  if (weeks.some((week) => week < 0 || week > MAX_PREGNANCY_WEEKS)) {
    return false;
  }
  const [first = 0, second = 0] = weeks.map(trimesterOf);
  return first !== second;
}

/** Past this gestational age an order is not part of the pregnancy dated. */
const MAX_PREGNANCY_WEEKS = 45;

/**
 * Whether `event` replaces the target (for example a newer order of the same
 * test). During a pregnancy, only within the same trimester.
 */
export function supersedes(
  event: ClinicalEvent,
  target: CorrelationTarget,
  timeline: PatientTimeline,
): boolean {
  return (
    refKey(event.source) !== refKey(target.expectation.source) &&
    !differentTrimesters(event, target.anchor, timeline) &&
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
    case 'patient.language_recorded':
    case 'record.withdrawn':
    case 'allergy.recorded':
      return `fulfilled_by_${event.type.replace('.', '_')}`;
  }
}
