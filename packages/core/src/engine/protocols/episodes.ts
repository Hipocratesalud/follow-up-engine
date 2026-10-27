import {
  itemSchedule,
  type Protocol,
  type ProtocolItem,
  type ProtocolOutcome,
} from '../../config/protocol.ts';
import type { ClinicalEvent, ConditionRecordedEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { enrollingConditions, icd10Matches } from '../annotator/conditions.ts';
import { encounterOf, type PatientTimeline } from '../timeline.ts';
import { currentDating, dateAtGestationalWeek, type PregnancyDating } from './gestational-age.ts';

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
  readonly outcome: ProtocolOutcome;
  /** The diagnosis that ended it (the delivery, the loss). */
  readonly endedBy: ConditionRecordedEvent;
  /** The diagnosis was recorded at a visit after the outcome (a puerperal visit), which counts as one. */
  readonly endedAtFollowUp: boolean;
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

/** Whether the record behind a condition came after an episode ended (so it starts a new one). */
export function startsAfter(
  condition: PatientCondition,
  closure: ClinicalEvent,
  timeline: PatientTimeline,
): boolean {
  const recorded = timeline.bySource(condition.source);
  return recorded === undefined
    ? condition.updatedAt.getTime() > closure.occurredAt.getTime()
    : afterClosure(recorded, closure);
}

/**
 * The patient's episode of `protocol` as the record stands, or `undefined`
 * when the patient was never enrolled.
 */
export function protocolEpisode(
  protocol: Protocol,
  conditions: readonly PatientCondition[],
  timeline: PatientTimeline,
): ProtocolEpisode | undefined {
  const closure =
    protocol.closing === undefined ? undefined : latestClosure(protocol, timeline.events);
  // A condition recorded after the last end of the protocol starts a new episode.
  const [enrolledBy] = enrollingConditions(protocol, conditions)
    .filter((condition) => closure === undefined || startsAfter(condition, closure.event, timeline))
    .sort(
      (left, right) => Number(right.status === 'confirmed') - Number(left.status === 'confirmed'),
    );
  const enrolledAt = enrolledBy === undefined ? undefined : timeline.bySource(enrolledBy.source);
  if (enrolledBy !== undefined) {
    const since = closure?.event.occurredAt;
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
  if (closure === undefined) {
    return undefined;
  }
  const limit = closure.event.occurredAt.getTime();
  const since = latestClosure(
    protocol,
    timeline.events.filter((event) => event.occurredAt.getTime() < limit),
  )?.event.occurredAt;
  return {
    status: 'ended',
    outcome: closure.outcome,
    endedBy: closure.event,
    endedAtFollowUp: closure.atFollowUp,
    ...(since === undefined ? {} : { since }),
  };
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
