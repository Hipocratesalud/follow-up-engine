import {
  itemSchedule,
  type MedicationMatcher,
  type Protocol,
  type ProtocolItem,
  type ProtocolOutcome,
} from '../../config/protocol.ts';
import type {
  ClinicalEvent,
  ConditionRecordedEvent,
  EncounterFinishedEvent,
  MedicationPrescribedEvent,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { enrollingConditions, icd10Matches } from '../annotator/conditions.ts';
import { dischargedEncounters } from '../annotator/layers/cadence.ts';
import { canonicalSpecialty } from '../matching/specialty.ts';
import { visitSpecialtyFits } from '../matching/correlation.ts';
import { encounterOf, type PatientTimeline } from '../timeline.ts';
import { currentDating, dateAtGestationalWeek, type PregnancyDating } from './gestational-age.ts';
import { medicationMatches } from './treatment-changes.ts';

const MS_PER_DAY = 86_400_000;

/** How an episode ended: an outcome of the protocol's `closing`, or a discharge (`closesOnDischarge`). */
export type EpisodeEnd = ProtocolOutcome | 'discharge';

/**
 * Where a patient stands in a protocol. Chronic protocols are `active`
 * while a condition enrolls the patient. Episodic ones (a pregnancy) also
 * end: a diagnosis of one of the protocol's `closing` outcomes (a delivery,
 * a loss) ends the episode, and only a diagnosis recorded after that end
 * starts a new one.
 */
export type ProtocolEpisode = ActiveEpisode | EndedEpisode;

export interface ActiveEpisode {
  readonly status: 'active';
  /** The enrolling condition (a confirmed one first). */
  readonly enrolledBy: PatientCondition;
  /** The event of the record that enrolled the patient, when still in the record. */
  readonly enrolledAt?: ClinicalEvent;
  /** End of the previous episode: nothing before it belongs to this one. */
  readonly since?: Date;
  /** Pregnancy dating of the episode, when the record gives one. */
  readonly dating?: PregnancyDating;
  /**
   * Past this day nothing more is expected (the pregnancy reached the
   * protocol's `maxGestationalWeeks` with no outcome recorded).
   */
  readonly lastDay?: Date;
}

export interface EndedEpisode {
  readonly status: 'ended';
  readonly outcome: EpisodeEnd;
  /** What ended it: the diagnosis (the delivery, the loss), or the visit that discharged the patient. */
  readonly endedBy: ClinicalEvent;
  /** The diagnosis was recorded at a visit after the outcome (a puerperal visit). */
  readonly endedAtFollowUp: boolean;
  /**
   * When the outcome happened: the delivery or loss dated when it happened
   * (a delivery code, "cesárea hace 12 días" read from a note), else, when
   * only a later visit tells it (Z39), the earlier of that visit and the
   * estimated delivery date; the discharge itself for a discharge.
   */
  readonly outcomeAt: Date;
  /** End of the episode before this one, if any. */
  readonly since?: Date;
}

/** The latest diagnosis among `events` that ends an episode of the protocol, with its outcome. */
export function latestClosure(
  protocol: Protocol,
  events: readonly ClinicalEvent[],
):
  | {
      readonly event: ConditionRecordedEvent;
      readonly outcome: ProtocolOutcome;
      readonly atFollowUp: boolean;
    }
  | undefined {
  const outcomes = protocol.closing?.outcomes ?? [];
  let latest:
    { event: ConditionRecordedEvent; outcome: ProtocolOutcome; atFollowUp: boolean } | undefined;
  for (const event of events) {
    if (event.type !== 'condition.recorded') {
      continue;
    }
    const outcome = outcomes.find((candidate) =>
      icd10Matches(event.code, candidate.conditionCodes),
    );
    if (
      outcome !== undefined &&
      (latest === undefined || event.occurredAt.getTime() >= latest.event.occurredAt.getTime())
    ) {
      latest = {
        event,
        outcome: outcome.outcome,
        atFollowUp: outcome.recordedAtFollowUp === true,
      };
    }
  }
  return latest;
}

/** Whether `event` happened after `closure`, and outside the encounter that recorded it. */
export function afterClosure(event: ClinicalEvent | undefined, closure: ClinicalEvent): boolean {
  if (event === undefined || event.occurredAt.getTime() <= closure.occurredAt.getTime()) {
    return false;
  }
  const encounter = encounterOf(event);
  return encounter === undefined || encounter !== encounterOf(closure);
}

/**
 * Whether the record behind a condition came after an episode ended (so it
 * starts a new one): after the closure, outside its encounter, and at least
 * `minGapDays` later (a pregnancy diagnosis right after a delivery is still
 * the pregnancy that ended, see {@link NEW_EPISODE_MIN_DAYS}).
 */
export function startsAfter(
  condition: PatientCondition,
  closure: ClinicalEvent,
  timeline: PatientTimeline,
  minGapDays = 0,
): boolean {
  const recorded = timeline.bySource(condition.source);
  const at = recorded?.occurredAt ?? condition.updatedAt;
  const late = at.getTime() - closure.occurredAt.getTime() >= minGapDays * MS_PER_DAY;
  return recorded === undefined
    ? condition.updatedAt.getTime() > closure.occurredAt.getTime() && late
    : afterClosure(recorded, closure) && late;
}

/** A closure of the protocol: what ended the last episode, and how. */
interface Closure {
  readonly event: ClinicalEvent;
  readonly outcome: EpisodeEnd;
  readonly atFollowUp: boolean;
}

/**
 * The latest visit of one of the protocol's specialties whose note
 * discharged the patient, when the protocol `closesOnDischarge`.
 */
export function latestDischarge(
  protocol: Protocol,
  timeline: PatientTimeline,
  before?: Date,
): EncounterFinishedEvent | undefined {
  if (protocol.closesOnDischarge !== true) {
    return undefined;
  }
  const discharged = dischargedEncounters(timeline);
  if (discharged.size === 0) {
    return undefined;
  }
  const specialties = new Set((protocol.specialties ?? []).map(canonicalSpecialty));
  return timeline
    .encounters()
    .filter(
      (encounter) =>
        discharged.has(encounterOf(encounter) ?? encounter.source.id) &&
        (before === undefined || encounter.occurredAt.getTime() < before.getTime()) &&
        visitSpecialtyFits(specialties, undefined, encounter, timeline),
    )
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .at(-1);
}

/** The drugs that enroll in the protocol or keep the patient in it. */
function protocolDrugs(protocol: Protocol): MedicationMatcher[] {
  return [
    ...(protocol.enrollment.medications ?? []),
    ...(protocol.enrollment.activeTreatment === undefined
      ? []
      : [protocol.enrollment.activeTreatment]),
  ];
}

/**
 * The first record after a discharge that starts a new episode: an
 * enrolling diagnosis or a prescription of the protocol's drugs, at a later
 * consultation.
 */
function restartAfter(
  protocol: Protocol,
  closure: ClinicalEvent,
  timeline: PatientTimeline,
): ClinicalEvent | undefined {
  const drugs = protocolDrugs(protocol);
  return timeline.events.find(
    (event) =>
      afterClosure(event, closure) &&
      ((event.type === 'condition.recorded' &&
        icd10Matches(event.code, protocol.enrollment.conditionCodes)) ||
        (event.type === 'medication.prescribed' &&
          drugs.some((matcher) => medicationMatches(event.medication, matcher)))),
  );
}

/** The latest closure of the protocol before `limit` (an outcome or a discharge), if any. */
function closureOf(
  protocol: Protocol,
  timeline: PatientTimeline,
  limit?: Date,
): Closure | undefined {
  const events =
    limit === undefined
      ? timeline.events
      : timeline.events.filter((event) => event.occurredAt.getTime() < limit.getTime());
  const outcome = protocol.closing === undefined ? undefined : latestClosure(protocol, events);
  const discharge = latestDischarge(protocol, timeline, limit);
  if (
    discharge !== undefined &&
    (outcome === undefined || discharge.occurredAt.getTime() > outcome.event.occurredAt.getTime())
  ) {
    return { event: discharge, outcome: 'discharge', atFollowUp: false };
  }
  return outcome;
}

/**
 * Whether the patient has an active prescription of `matcher` (after
 * `since`): one the record did not withdraw (stopped, cancelled) and, when
 * it states how long it covers, whose supply and refills are not over at
 * `now`.
 */
export function onActiveTreatment(
  matcher: MedicationMatcher,
  timeline: PatientTimeline,
  now: Date | undefined,
  since?: Date,
): boolean {
  return timeline.events.some(
    (event): event is MedicationPrescribedEvent =>
      event.type === 'medication.prescribed' &&
      (since === undefined || event.occurredAt.getTime() > since.getTime()) &&
      (now === undefined || event.occurredAt.getTime() <= now.getTime()) &&
      medicationMatches(event.medication, matcher) &&
      (now === undefined ||
        event.durationDays === undefined ||
        event.startAt.getTime() + event.durationDays * (1 + (event.refills ?? 0)) * MS_PER_DAY >=
          now.getTime()),
  );
}

/**
 * The patient's episode of `protocol` as the record stands at `now`, or
 * `undefined` when the patient is not enrolled: never enrolled, or (a
 * treatment protocol, `activeTreatment`) not on an active prescription of
 * its drugs.
 */
export function protocolEpisode(
  protocol: Protocol,
  conditions: readonly PatientCondition[],
  timeline: PatientTimeline,
  now?: Date,
): ProtocolEpisode | undefined {
  const closure = closureOf(protocol, timeline);
  const enrolling = enrollingConditions(protocol, conditions);
  let enrolledBy: PatientCondition | undefined;
  let restart: ClinicalEvent | undefined;
  if (closure?.outcome === 'discharge') {
    // A discharge ends the episode; a later diagnosis or prescription starts the next one.
    restart = restartAfter(protocol, closure.event, timeline);
    enrolledBy = restart === undefined ? undefined : confirmedFirst(enrolling)[0];
  } else {
    // A condition recorded after the last end of the protocol starts a new episode.
    [enrolledBy] = confirmedFirst(
      enrolling.filter(
        (condition) =>
          closure === undefined ||
          startsAfter(condition, closure.event, timeline, NEW_EPISODE_MIN_DAYS),
      ),
    );
  }
  const since = closure?.event.occurredAt;
  const treatment = protocol.enrollment.activeTreatment;
  if (
    enrolledBy !== undefined &&
    (treatment === undefined || onActiveTreatment(treatment, timeline, now, since))
  ) {
    const enrolledAt = restart ?? timeline.bySource(enrolledBy.source);
    const dating =
      protocol.closing === undefined ? undefined : currentDating(timeline.events, since);
    const maxWeeks = protocol.closing?.maxGestationalWeeks;
    return {
      status: 'active',
      enrolledBy,
      ...(enrolledAt === undefined ? {} : { enrolledAt }),
      ...(since === undefined ? {} : { since }),
      ...(dating === undefined ? {} : { dating }),
      ...(dating === undefined || maxWeeks === undefined
        ? {}
        : { lastDay: dateAtGestationalWeek(dating, maxWeeks) }),
    };
  }
  if (
    closure === undefined ||
    (closure.outcome === 'discharge' && (enrolledBy !== undefined || enrolling.length === 0))
  ) {
    return undefined;
  }
  const previous = previousEpisodeEnd(protocol, timeline, closure.event);
  return {
    status: 'ended',
    outcome: closure.outcome,
    endedBy: closure.event,
    endedAtFollowUp: closure.atFollowUp,
    outcomeAt: outcomeDate(protocol, timeline, closure, previous?.event.occurredAt),
    ...(previous === undefined ? {} : { since: previous.event.occurredAt }),
  };
}

/**
 * When the outcome that ended an episode happened (see `EndedEpisode.outcomeAt`):
 * the earliest outcome diagnosis dated at the outcome (not one recorded at a
 * later visit) after the previous episode's end, else the earlier of the
 * closure and the pregnancy's estimated delivery date.
 */
function outcomeDate(
  protocol: Protocol,
  timeline: PatientTimeline,
  closure: Closure,
  since: Date | undefined,
): Date {
  if (closure.outcome === 'discharge') {
    return closure.event.occurredAt;
  }
  const atOutcome = (protocol.closing?.outcomes ?? []).filter(
    (outcome) => outcome.recordedAtFollowUp !== true,
  );
  let earliest: Date | undefined;
  for (const event of timeline.ofType('condition.recorded')) {
    const at = event.occurredAt.getTime();
    if (
      at <= closure.event.occurredAt.getTime() &&
      (since === undefined || at > since.getTime()) &&
      atOutcome.some((outcome) => icd10Matches(event.code, outcome.conditionCodes)) &&
      (earliest === undefined || at < earliest.getTime())
    ) {
      earliest = event.occurredAt;
    }
  }
  if (earliest !== undefined) {
    return earliest;
  }
  const dating = closure.atFollowUp ? currentDating(timeline.events, since) : undefined;
  return dating !== undefined &&
    dating.estimatedDeliveryDate.getTime() < closure.event.occurredAt.getTime()
    ? dating.estimatedDeliveryDate
    : closure.event.occurredAt;
}

/**
 * The end of the episode before the one that ended at `closure`: the latest
 * earlier closure followed by a new enrolling diagnosis. Closures with no
 * new pregnancy between them are one ending told twice (the delivery dated
 * when it happened, then the puerperal visit that codes Z39), so they never
 * split the episode.
 */
function previousEpisodeEnd(
  protocol: Protocol,
  timeline: PatientTimeline,
  closure: ClinicalEvent,
): Closure | undefined {
  let candidate = closureOf(protocol, timeline, closure.occurredAt);
  while (candidate !== undefined && !restartedBetween(protocol, timeline, candidate, closure)) {
    candidate = closureOf(protocol, timeline, candidate.event.occurredAt);
  }
  return candidate;
}

/**
 * A pregnancy diagnosis this soon after a delivery or a loss is still the
 * pregnancy that ended (an outcome read from a note is dated by the day: the
 * last prenatal visit can be the same day), not a new one.
 */
export const NEW_EPISODE_MIN_DAYS = 28;

/** Whether `event` comes late enough after an outcome to start a new episode. */
function startsNewEpisode(event: ClinicalEvent, closure: Closure): boolean {
  return (
    afterClosure(event, closure.event) &&
    (closure.outcome === 'discharge' ||
      event.occurredAt.getTime() - closure.event.occurredAt.getTime() >=
        NEW_EPISODE_MIN_DAYS * MS_PER_DAY)
  );
}

/** Whether a record after `previous` and before `closure` started a new episode. */
function restartedBetween(
  protocol: Protocol,
  timeline: PatientTimeline,
  previous: Closure,
  closure: ClinicalEvent,
): boolean {
  if (previous.outcome === 'discharge') {
    const restart = restartAfter(protocol, previous.event, timeline);
    return restart !== undefined && restart.occurredAt.getTime() <= closure.occurredAt.getTime();
  }
  return timeline.events.some(
    (event) =>
      event.type === 'condition.recorded' &&
      event.occurredAt.getTime() < closure.occurredAt.getTime() &&
      icd10Matches(event.code, protocol.enrollment.conditionCodes) &&
      startsNewEpisode(event, previous),
  );
}

function confirmedFirst(conditions: readonly PatientCondition[]): PatientCondition[] {
  return [...conditions].sort(
    (left, right) => Number(right.status === 'confirmed') - Number(left.status === 'confirmed'),
  );
}

/**
 * Whether an item of the protocol is expected in this episode: every item
 * while it is active, only the `after_outcome` items of its outcome once it
 * ended (the postpartum visit after a delivery, never another prenatal one).
 */
export function itemApplies(item: ProtocolItem, episode: ProtocolEpisode | undefined): boolean {
  if (episode === undefined) {
    return false;
  }
  const schedule = itemSchedule(item);
  if (episode.status === 'active') {
    return schedule.type !== 'after_outcome';
  }
  return schedule.type === 'after_outcome' && schedule.outcome === episode.outcome;
}
