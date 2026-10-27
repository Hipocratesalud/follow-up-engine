import type { CadenceEpisode, Rule } from '../../../config/rule.ts';
import type {
  ClinicalEvent,
  EncounterFinishedEvent,
  NoteReceivedEvent,
  PlanExtractedEvent,
  PlanItem,
} from '../../../domain/clinical-event.ts';
import type { Catalog } from '../../catalog.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { addDays } from '../../support/time.ts';
import { encounterOf, type PatientTimeline } from '../../timeline.ts';
import { icd10Matches } from '../conditions.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';
import { isShortCourse } from '../treatment.ts';

const MS_PER_DAY = 86_400_000;
/** How far a note not linked to its consultation may be from the visit to count as its note. */
const UNLINKED_NOTE_WINDOW_MS = MS_PER_DAY;

type CadenceSettings = NonNullable<Rule['cadence']>;

function sameSpecialty(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? upper) + upper) / 2 : upper;
}

function idOf(encounter: EncounterFinishedEvent): string {
  return encounterOf(encounter) ?? encounter.source.id;
}

/**
 * The patient's usual interval, in days, between `visits` (one specialty,
 * chronological), or `undefined` when they are not a pattern yet.
 */
export function usualIntervalDays(
  visits: readonly EncounterFinishedEvent[],
  cadence: Pick<CadenceSettings, 'minPreviousVisits' | 'minIntervalDays'>,
): number | undefined {
  if (visits.length < cadence.minPreviousVisits) {
    return undefined;
  }
  const times = visits.map((visit) => visit.occurredAt.getTime());
  const intervals = times
    .slice(1)
    .map((time, index) => (time - (times[index] ?? time)) / MS_PER_DAY)
    .filter((days) => days >= (cadence.minIntervalDays ?? 0) && days > 0);
  return intervals.length === 0 ? undefined : median(intervals);
}

/**
 * The consultation a plan belongs to: its own `encounterId`, else the visit
 * of the note's specialty on the same day (a note not linked to its
 * consultation).
 */
function planEncounterId(
  plan: PlanExtractedEvent,
  notes: readonly NoteReceivedEvent[],
  timeline: PatientTimeline,
): string | undefined {
  if (plan.encounterId !== undefined) {
    return plan.encounterId;
  }
  const note = notes.find((candidate) => candidate.documentId === plan.sourceDocumentId);
  const at = (note?.authoredAt ?? plan.occurredAt).getTime();
  const visit = timeline
    .encounters()
    .filter(
      (encounter) =>
        (note?.specialty === undefined || sameSpecialty(encounter.specialty, note.specialty)) &&
        Math.abs(encounter.occurredAt.getTime() - at) <= UNLINKED_NOTE_WINDOW_MS,
    )
    .at(-1);
  return visit === undefined ? undefined : idOf(visit);
}

/**
 * Encounters whose note discharged the patient ("se da de alta"). A note not
 * linked to its consultation counts for the visit of its specialty on the
 * same day.
 */
export function dischargedEncounters(timeline: PatientTimeline): Set<string> {
  const discharged = new Set<string>();
  const notes = timeline.ofType('note.received');
  for (const plan of timeline.ofType('plan.extracted')) {
    const encounterId =
      plan.discharged === true ? planEncounterId(plan, notes, timeline) : undefined;
    if (encounterId !== undefined) {
      discharged.add(encounterId);
    }
  }
  return discharged;
}

/** Kinds of plan item that ask the patient to come back. */
const PLANNED_VISIT_KINDS: ReadonlySet<PlanItem['kind']> = new Set(['follow_up_visit', 'session']);

/** For each consultation whose plan asked for a control visit, the latest date it was asked by. */
function plannedVisitDueByEncounter(timeline: PatientTimeline): Map<string, Date> {
  const due = new Map<string, Date>();
  const notes = timeline.ofType('note.received');
  for (const plan of timeline.ofType('plan.extracted')) {
    const visits = plan.items.filter((item) => PLANNED_VISIT_KINDS.has(item.kind));
    const encounterId = visits.length === 0 ? undefined : planEncounterId(plan, notes, timeline);
    if (encounterId === undefined) {
      continue;
    }
    for (const item of visits) {
      const current = due.get(encounterId);
      if (current === undefined || item.dueAt.getTime() > current.getTime()) {
        due.set(encounterId, item.dueAt);
      }
    }
  }
  return due;
}

/**
 * Planned controls that are not independent visits: the next visit of the
 * specialty that came as the control a visit's plan asked for, when it ends
 * the chain (it plans no further visit). So a visit and its own control never
 * make a pattern by themselves (a sprain and its control, "control en 14
 * días" and the control). Three or more visits chained by their plans are a
 * routine of planned controls and all stay.
 */
function closingControlVisits(
  visits: readonly EncounterFinishedEvent[],
  settings: NonNullable<CadenceSettings['plannedControl']>,
  timeline: PatientTimeline,
): string[] {
  const planned = plannedVisitDueByEncounter(timeline);
  const linked = visits.map((visit, index) => {
    const next = visits[index + 1];
    const due = planned.get(idOf(visit));
    if (next === undefined || due === undefined) {
      return false;
    }
    const plannedInterval = Math.max(0, (due.getTime() - visit.occurredAt.getTime()) / MS_PER_DAY);
    const deadline = addDays(due, Math.max(settings.withinDays, plannedInterval));
    return next.occurredAt.getTime() <= deadline.getTime();
  });
  const closed: string[] = [];
  let start = 0;
  while (start < visits.length) {
    let end = start;
    while (linked[end] === true) {
      end += 1;
    }
    const control = visits[end];
    if (end - start === 1 && control !== undefined && !planned.has(idOf(control))) {
      closed.push(idOf(control));
    }
    start = end + 1;
  }
  return closed;
}

function diagnosesByEncounter(timeline: PatientTimeline): Map<string, ClinicalEvent[]> {
  const byEncounter = new Map<string, ClinicalEvent[]>();
  for (const event of timeline.ofType('condition.recorded')) {
    if (event.encounterId !== undefined) {
      byEncounter.set(event.encounterId, [...(byEncounter.get(event.encounterId) ?? []), event]);
    }
  }
  return byEncounter;
}

function hasDiagnosis(
  diagnoses: readonly ClinicalEvent[] | undefined,
  codes: readonly string[],
): boolean {
  return (diagnoses ?? []).some(
    (event) => event.type === 'condition.recorded' && icd10Matches(event.code, codes),
  );
}

/** Visits of an episode (pregnancy) up to the visit that closed it (postpartum). */
function closedEpisodeVisits(
  visits: readonly EncounterFinishedEvent[],
  episode: CadenceEpisode,
  diagnoses: ReadonlyMap<string, readonly ClinicalEvent[]>,
): string[] {
  const closed: string[] = [];
  let current: string[] = [];
  for (const visit of visits) {
    const recorded = diagnoses.get(idOf(visit));
    const closes = hasDiagnosis(recorded, episode.closedBy);
    if (closes || hasDiagnosis(recorded, episode.conditionCodes)) {
      current.push(idOf(visit));
    }
    if (closes) {
      closed.push(...current);
      current = [];
    }
  }
  return closed;
}

/**
 * An acute episode and its control: a visit that started a short treatment
 * and the next visit of the specialty within the treatment plus
 * `controlWithinDays`.
 */
function acuteEpisodeVisits(
  visits: readonly EncounterFinishedEvent[],
  settings: NonNullable<CadenceSettings['acuteEpisode']>,
  timeline: PatientTimeline,
  catalog: Catalog,
): string[] {
  const rule = catalog.rules.find((candidate) => candidate.id === settings.treatmentRule);
  const criteria = rule?.treatment;
  if (rule === undefined || criteria === undefined) {
    return [];
  }
  const closed: string[] = [];
  const prescriptions = timeline.ofType('medication.prescribed');
  visits.forEach((visit, index) => {
    const next = visits[index + 1];
    if (next === undefined) {
      return;
    }
    const courses = prescriptions.filter(
      (event) => event.encounterId === idOf(visit) && isShortCourse(rule, criteria, event),
    );
    const longest = Math.max(...courses.map((event) => event.durationDays ?? 0));
    const window = addDays(visit.occurredAt, longest + settings.controlWithinDays);
    if (courses.length > 0 && next.occurredAt.getTime() <= window.getTime()) {
      closed.push(idOf(visit), idOf(next));
    }
  });
  return closed;
}

/**
 * The visits of one specialty, up to `current`, that make the patient's
 * pattern: closed episodes left out (everything up to a discharge, a
 * pregnancy once its postpartum visit came, an acute episode and its
 * control, the control a single visit's plan asked for).
 */
export function patternVisits(
  visits: readonly EncounterFinishedEvent[],
  cadence: CadenceSettings,
  timeline: PatientTimeline,
  catalog: Catalog,
  discharged: ReadonlySet<string>,
): EncounterFinishedEvent[] {
  const lastDischarge = visits.findLastIndex((visit) => discharged.has(idOf(visit)));
  const diagnoses = diagnosesByEncounter(timeline);
  const closed = new Set([
    ...visits.slice(0, lastDischarge + 1).map(idOf),
    ...(cadence.episodes ?? []).flatMap((episode) =>
      closedEpisodeVisits(visits, episode, diagnoses),
    ),
    ...(cadence.acuteEpisode === undefined
      ? []
      : acuteEpisodeVisits(visits, cadence.acuteEpisode, timeline, catalog)),
    ...(cadence.plannedControl === undefined
      ? []
      : closingControlVisits(visits, cadence.plannedControl, timeline)),
  ]);
  return visits.filter((visit) => !closed.has(idOf(visit)));
}

/**
 * Cadence layer: a break in the patient's own visit pattern. Once the patient
 * has `minPreviousVisits` visits of the same specialty in their pattern (2:
 * one interval is already a pattern, a single visit never is), the next
 * visit is expected within `multiplier` times the median interval, counted
 * from the latest visit of the specialty. Closed episodes are not a pattern
 * (see {@link patternVisits}), and a visit whose note discharged the patient
 * anchors nothing.
 */
export function cadenceDrafts(
  events: readonly ClinicalEvent[],
  timeline: PatientTimeline,
  catalog: Catalog,
): ExpectationDraft[] {
  const encounters = timeline.encounters();
  const discharged = dischargedEncounters(timeline);
  const drafts: ExpectationDraft[] = [];
  for (const rule of catalog.rulesOfLayer('cadence')) {
    const definition = catalog.definition(rule.id);
    if (definition === undefined || rule.cadence === undefined) {
      continue;
    }
    for (const event of events) {
      if (event.type !== 'encounter.finished') {
        continue;
      }
      const current = timeline.encounter(encounterOf(event) ?? event.source.id) ?? event;
      const visits = encounters.filter(
        (encounter) =>
          sameSpecialty(encounter.specialty, current.specialty) &&
          encounter.occurredAt.getTime() <= current.occurredAt.getTime(),
      );
      const isLatest = !encounters.some(
        (other) =>
          sameSpecialty(other.specialty, current.specialty) &&
          other.occurredAt.getTime() > current.occurredAt.getTime(),
      );
      if (!isLatest || discharged.has(idOf(current))) {
        continue;
      }
      const interval = usualIntervalDays(
        patternVisits(visits, rule.cadence, timeline, catalog, discharged),
        rule.cadence,
      );
      if (interval === undefined) {
        continue;
      }
      drafts.push({
        definition,
        source: current.source,
        matchKey: matchKeyFor(definition.expects ?? 'follow_up_visit', undefined),
        dueAt: addDays(current.occurredAt, rule.cadence.multiplier * interval),
        idempotencyKey: expectationIdempotencyKey(current.source, rule.id),
      });
    }
  }
  return drafts;
}
