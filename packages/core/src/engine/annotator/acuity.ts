import type { RelevanceHorizon, Rule } from '../../config/rule.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Catalog } from '../catalog.ts';
import { kindOfMatchKey } from '../matching/match-key.ts';
import { daysBetween } from '../support/time.ts';
import { encounterOf, eventInstant, type PatientTimeline } from '../timeline.ts';
import { icd10Matches } from './conditions.ts';
import { isChronicMedication, isShortCourse } from './treatment.ts';

/**
 * What a consultation was about, for the relevance of what it asked for:
 * `chronic` care (a condition a protocol follows, a chronic drug), an
 * `acute` episode (a short course for a cold, a urinary infection, a
 * gastritis) or a `routine` visit (a yearly control, a screening).
 */
export type VisitAcuity = 'acute' | 'chronic' | 'routine';

/** The catalog's short-treatment rule: the one whose criteria define a short course. */
function treatmentRule(catalog: Catalog): Rule | undefined {
  return catalog.rules.find((rule) => rule.treatment !== undefined);
}

/**
 * The acuity of the consultation `encounterId` (see {@link VisitAcuity}):
 * chronic when it records a condition an enabled protocol enrolls or one of
 * `chronicConditionCodes`, or prescribes a chronic drug class; acute when it
 * starts a short course of treatment; routine otherwise.
 */
export function visitAcuity(
  encounterId: string,
  timeline: PatientTimeline,
  catalog: Catalog,
  chronicConditionCodes: readonly string[] = [],
): VisitAcuity {
  const events = timeline.events.filter((event) => encounterOf(event) === encounterId);
  const enrolling = [
    ...chronicConditionCodes,
    ...catalog.protocols.flatMap((protocol) => protocol.enrollment.conditionCodes),
  ];
  const rule = treatmentRule(catalog);
  const criteria = rule?.treatment;
  const chronic = events.some(
    (event) =>
      (event.type === 'condition.recorded' && icd10Matches(event.code, enrolling)) ||
      (event.type === 'medication.prescribed' &&
        criteria !== undefined &&
        isChronicMedication(event, criteria)),
  );
  if (chronic) {
    return 'chronic';
  }
  const acute =
    rule !== undefined &&
    criteria !== undefined &&
    events.some(
      (event) => event.type === 'medication.prescribed' && isShortCourse(rule, criteria, event),
    );
  return acute ? 'acute' : 'routine';
}

function visitsMatch(horizon: RelevanceHorizon, acuity: VisitAcuity | undefined): boolean {
  switch (horizon.visits) {
    case 'any':
      return true;
    case 'acute':
      return acuity === 'acute';
    case 'non_chronic':
      return acuity === 'acute' || acuity === 'routine';
  }
}

/** Machine reason (`closedReason`) of an expectation closed by its relevance horizon. */
export const PAST_RELEVANCE_HORIZON = 'past_relevance_horizon';

/**
 * The relevance horizon that closes `expectation` instead of letting it open
 * a case at `now`, if one does (see `Rule.relevance`): the first of its
 * rule's horizons whose kind, interval and visit acuity apply, and that
 * `expectation` is overdue past.
 */
export function pastRelevanceHorizon(input: {
  readonly expectation: Expectation;
  readonly catalog: Catalog;
  readonly timeline: PatientTimeline;
  readonly now: Date;
}): RelevanceHorizon | undefined {
  const { expectation, catalog, timeline, now } = input;
  const horizons = catalog.rules.find((rule) => rule.id === expectation.ruleId)?.relevance;
  if (horizons === undefined) {
    return undefined;
  }
  const overdueDays = daysBetween(expectation.dueAt, now);
  const anchor = timeline.bySource(expectation.source);
  const encounterId = anchor === undefined ? undefined : encounterOf(anchor);
  const kind =
    catalog.definition(expectation.ruleId)?.expects ?? kindOfMatchKey(expectation.matchKey);
  const intervalDays =
    anchor === undefined ? undefined : daysBetween(eventInstant(anchor), expectation.dueAt);
  return horizons.find((horizon) => {
    if (overdueDays <= horizon.afterOverdueDays) {
      return false;
    }
    if (horizon.kinds !== undefined && !horizon.kinds.includes(kind)) {
      return false;
    }
    if (
      horizon.maxIntervalDays !== undefined &&
      (intervalDays === undefined || intervalDays > horizon.maxIntervalDays)
    ) {
      return false;
    }
    const acuity =
      encounterId === undefined
        ? undefined
        : visitAcuity(encounterId, timeline, catalog, horizon.chronicConditionCodes);
    return visitsMatch(horizon, acuity);
  });
}
