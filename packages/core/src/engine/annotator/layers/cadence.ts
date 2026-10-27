import type { CadenceEpisode, Rule } from '../../../config/rule.ts';
import type { ClinicalEvent, EncounterFinishedEvent } from '../../../domain/clinical-event.ts';
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
 * Encounters whose note discharged the patient ("se da de alta"). A note not
 * linked to its consultation counts for the visit of its specialty on the
 * same day.
 */
export function dischargedEncounters(timeline: PatientTimeline): Set<string> {
  const discharged = new Set<string>();
  const notes = timeline.ofType('note.received');
  for (const plan of timeline.ofType('plan.extracted')) {
    if (plan.discharged !== true) {
      continue;
    }
    if (plan.encounterId !== undefined) {
      discharged.add(plan.encounterId);
      continue;
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
    if (visit !== undefined) {
      discharged.add(idOf(visit));
    }
  }
  return discharged;
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
 * control).
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
