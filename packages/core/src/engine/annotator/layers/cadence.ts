import type { Rule } from '../../../config/rule.ts';
import type { ClinicalEvent, EncounterFinishedEvent } from '../../../domain/clinical-event.ts';
import type { Catalog } from '../../catalog.ts';
import { matchKeyFor } from '../../matching/match-key.ts';
import { addDays } from '../../support/time.ts';
import { encounterOf, type PatientTimeline } from '../../timeline.ts';
import { type ExpectationDraft, expectationIdempotencyKey } from '../draft.ts';

const MS_PER_DAY = 86_400_000;

function sameSpecialty(left: string | undefined, right: string | undefined): boolean {
  return (left ?? '').trim().toLowerCase() === (right ?? '').trim().toLowerCase();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? upper) + upper) / 2 : upper;
}

/**
 * The patient's usual interval, in days, between visits of one specialty up
 * to and including `current`, or `undefined` when there is no pattern yet.
 */
export function usualIntervalDays(
  encounters: readonly EncounterFinishedEvent[],
  current: EncounterFinishedEvent,
  cadence: NonNullable<Rule['cadence']>,
): number | undefined {
  const visits = encounters
    .filter(
      (encounter) =>
        sameSpecialty(encounter.specialty, current.specialty) &&
        encounter.occurredAt.getTime() <= current.occurredAt.getTime(),
    )
    .map((encounter) => encounter.occurredAt.getTime());
  if (visits.length - 1 < cadence.minPreviousVisits) {
    return undefined;
  }
  const intervals = visits
    .slice(1)
    .map((visit, index) => (visit - (visits[index] ?? visit)) / MS_PER_DAY)
    .filter((days) => days >= (cadence.minIntervalDays ?? 0) && days > 0);
  return intervals.length === 0 ? undefined : median(intervals);
}

/**
 * Cadence layer: a break in the patient's own visit pattern. With at least
 * `minPreviousVisits` earlier visits of the same specialty, the next visit is
 * expected within `multiplier` times the median interval. Only the latest
 * visit of the specialty anchors an expectation.
 */
export function cadenceDrafts(
  events: readonly ClinicalEvent[],
  timeline: PatientTimeline,
  catalog: Catalog,
): ExpectationDraft[] {
  const encounters = timeline.encounters();
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
      const isLatest = !encounters.some(
        (other) =>
          sameSpecialty(other.specialty, current.specialty) &&
          other.occurredAt.getTime() > current.occurredAt.getTime(),
      );
      const interval = isLatest ? usualIntervalDays(encounters, current, rule.cadence) : undefined;
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
