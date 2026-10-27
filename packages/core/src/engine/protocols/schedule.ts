import { itemSchedule, type ProtocolItem, type ProtocolScheduleOf } from '../../config/protocol.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { definitionVisitFits, matchesShape } from '../matching/correlation.ts';
import { addDays } from '../support/time.ts';
import { encounterOf, eventInstant, type PatientTimeline } from '../timeline.ts';
import type { ActiveEpisode, EndedEpisode, ProtocolEpisode } from './episodes.ts';
import { dateAtGestationalWeek, gestationalAgeAt } from './gestational-age.ts';
import { ckdStage } from './kidney.ts';
import { type TreatmentChange, treatmentChanges } from './treatment-changes.ts';

/**
 * When a protocol item is next expected, by its schedule: what the
 * expectation is counted from (`anchor`, the resource that triggers it, so
 * reprocessing the same record yields the same expectation) and its due
 * date. `undefined` when nothing is expected now.
 */
export interface ScheduledItem {
  readonly anchor: ResourceRef;
  readonly dueAt: Date;
}

export interface ScheduleInput {
  readonly item: ProtocolItem;
  readonly definition: ExpectationDefinition;
  readonly episode: ProtocolEpisode;
  readonly conditions: readonly PatientCondition[];
  readonly timeline: PatientTimeline;
  readonly now: Date;
}

const MS_PER_DAY = 86_400_000;

/**
 * The events that count as the item happening (a visit, a result), oldest
 * first, after `since`. A booking is a promise, not a visit: it fulfills
 * the item's expectation (until it is cancelled or its date passes with no
 * visit) but never anchors the next one, so the next item is always counted
 * from something that took place.
 */
export function fulfillingEvents(
  definition: ExpectationDefinition,
  timeline: PatientTimeline,
  since?: Date,
): ClinicalEvent[] {
  return timeline.events
    .filter(
      (event) =>
        event.type !== 'appointment.booked' &&
        (since === undefined || eventInstant(event).getTime() > since.getTime()) &&
        definition.fulfilledBy.some((correlation) =>
          matchesShape(correlation, event, definition.code),
        ) &&
        definitionVisitFits(definition, event, timeline),
    )
    .sort((left, right) => eventInstant(left).getTime() - eventInstant(right).getTime());
}

/** What the item counts from when it never happened: the record that enrolled the patient. */
function fromEnrollment(
  episode: ActiveEpisode,
  now: Date,
): { readonly source: ResourceRef; readonly at: Date } {
  return { source: episode.enrolledBy.source, at: episode.enrolledAt?.occurredAt ?? now };
}

/** `everyDays` after the last time it happened, else after enrollment. */
function fromLast(
  last: ClinicalEvent | undefined,
  episode: ActiveEpisode,
  now: Date,
  everyDays: number,
): ScheduledItem {
  const from =
    last === undefined
      ? fromEnrollment(episode, now)
      : { source: last.source, at: eventInstant(last) };
  return { anchor: from.source, dueAt: addDays(from.at, everyDays) };
}

/** Whether `event` came after the change, outside the consultation that made it. */
function afterChange(event: ClinicalEvent, change: TreatmentChange, minDays = 0): boolean {
  const changedAt = change.event.occurredAt.getTime();
  const encounter = encounterOf(event);
  return (
    eventInstant(event).getTime() >= changedAt + minDays * MS_PER_DAY &&
    eventInstant(event).getTime() > changedAt &&
    (encounter === undefined || encounter !== encounterOf(change.event))
  );
}

function treatmentChangeSchedule(
  schedule: ProtocolScheduleOf<'treatment_change'>,
  input: ScheduleInput,
  episode: ActiveEpisode,
): ScheduledItem {
  const fulfilled = fulfillingEvents(input.definition, input.timeline);
  const last = fulfilled.at(-1);
  const change = treatmentChanges(input.timeline.events, schedule.medications).at(-1);
  if (change === undefined) {
    return fromLast(last, episode, input.now, schedule.everyDays);
  }
  const counted = fulfilled.filter((event) =>
    afterChange(event, change, schedule.minDaysAfterChange),
  );
  if (counted.length === 0) {
    // The control after the change is still due. Something that happened
    // too soon after it (a TSH a week after a new dose) does not count, and
    // the next expectation is counted from it, still due on the same day.
    const early = last !== undefined && afterChange(last, change) ? last : undefined;
    return {
      anchor: (early ?? change.event).source,
      dueAt: addDays(change.event.occurredAt, schedule.afterChangeDays),
    };
  }
  const titrating =
    schedule.untilStable !== undefined && counted.length < schedule.untilStable.controls;
  return fromLast(
    last,
    episode,
    input.now,
    titrating && schedule.untilStable !== undefined
      ? schedule.untilStable.everyDays
      : schedule.everyDays,
  );
}

function gestationalAgeSchedule(
  schedule: ProtocolScheduleOf<'gestational_age'>,
  input: ScheduleInput,
  episode: ActiveEpisode,
): ScheduledItem | undefined {
  const last = fulfillingEvents(input.definition, input.timeline, episode.since).at(-1);
  const from =
    last === undefined
      ? fromEnrollment(episode, input.now)
      : { source: last.source, at: eventInstant(last) };
  const { dating, lastDay } = episode;
  if (lastDay !== undefined && from.at.getTime() >= lastDay.getTime()) {
    return undefined;
  }
  const weeks = dating === undefined ? undefined : gestationalAgeAt(dating, from.at).weeks;
  const everyDays =
    weeks === undefined
      ? schedule.undatedEveryDays
      : (schedule.intervals.find((interval) => weeks < interval.untilWeek)?.everyDays ??
        schedule.intervals.at(-1)?.everyDays ??
        schedule.undatedEveryDays);
  const due = addDays(from.at, everyDays);
  return {
    anchor: from.source,
    dueAt: lastDay !== undefined && due.getTime() > lastDay.getTime() ? lastDay : due,
  };
}

function gestationalWindowSchedule(
  schedule: ProtocolScheduleOf<'gestational_window'>,
  input: ScheduleInput,
  episode: ActiveEpisode,
): ScheduledItem | undefined {
  const { dating, lastDay } = episode;
  if (dating === undefined) {
    return undefined;
  }
  const opens = dateAtGestationalWeek(dating, schedule.fromWeek);
  if (
    input.now.getTime() < opens.getTime() ||
    (lastDay !== undefined && opens.getTime() > lastDay.getTime())
  ) {
    return undefined;
  }
  const done = fulfillingEvents(input.definition, input.timeline, episode.since).some(
    (event) => eventInstant(event).getTime() >= opens.getTime(),
  );
  if (done) {
    return undefined;
  }
  // Counted from the first thing recorded once the window opened, so the
  // same window always yields the same expectation and nothing before the
  // window fulfills it.
  const first = input.timeline.events.find(
    (event) =>
      event.type !== 'appointment.booked' &&
      event.occurredAt.getTime() >= opens.getTime() &&
      event.occurredAt.getTime() <= input.now.getTime(),
  );
  return first === undefined
    ? undefined
    : { anchor: first.source, dueAt: dateAtGestationalWeek(dating, schedule.toWeek) };
}

function afterOutcomeSchedule(
  schedule: ProtocolScheduleOf<'after_outcome'>,
  input: ScheduleInput,
  episode: EndedEpisode,
): ScheduledItem | undefined {
  const closure = episode.endedBy;
  const closedAt = closure.occurredAt.getTime();
  const encounter = encounterOf(closure);
  // The visit where the outcome was recorded (the puerperal visit that
  // codes Z39) is itself the visit after it.
  const done = fulfillingEvents(input.definition, input.timeline).some(
    (event) =>
      eventInstant(event).getTime() >= closedAt ||
      (encounter !== undefined && encounterOf(event) === encounter),
  );
  return done
    ? undefined
    : { anchor: closure.source, dueAt: addDays(closure.occurredAt, schedule.withinDays) };
}

function ckdStageSchedule(
  schedule: ProtocolScheduleOf<'ckd_stage'>,
  input: ScheduleInput,
  episode: ActiveEpisode,
): ScheduledItem {
  const stage = ckdStage(input.timeline.events, input.conditions);
  const interval = schedule.intervals.find(
    (candidate) =>
      stage.gfr !== undefined &&
      candidate.gfr.includes(stage.gfr) &&
      (candidate.albuminuria === undefined ||
        (stage.albuminuria !== undefined && candidate.albuminuria.includes(stage.albuminuria))),
  );
  const last = fulfillingEvents(input.definition, input.timeline).at(-1);
  return fromLast(last, episode, input.now, interval?.everyDays ?? schedule.everyDays);
}

/** When the item is next expected, if it is (see {@link ScheduledItem}). */
export function scheduleItem(input: ScheduleInput): ScheduledItem | undefined {
  const schedule = itemSchedule(input.item);
  const { episode } = input;
  if (schedule.type === 'after_outcome') {
    return episode.status === 'ended' && episode.outcome === schedule.outcome
      ? afterOutcomeSchedule(schedule, input, episode)
      : undefined;
  }
  if (episode.status !== 'active') {
    return undefined;
  }
  switch (schedule.type) {
    case 'interval':
      return fromLast(
        fulfillingEvents(input.definition, input.timeline, episode.since).at(-1),
        episode,
        input.now,
        schedule.everyDays,
      );
    case 'treatment_change':
      return treatmentChangeSchedule(schedule, input, episode);
    case 'gestational_age':
      return gestationalAgeSchedule(schedule, input, episode);
    case 'gestational_window':
      return gestationalWindowSchedule(schedule, input, episode);
    case 'ckd_stage':
      return ckdStageSchedule(schedule, input, episode);
  }
}
