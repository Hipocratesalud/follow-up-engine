import type { FindingCoverage } from '../../domain/clinical-finding.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Catalog } from '../catalog.ts';
import { parseCodeMatchKey } from '../matching/match-key.ts';
import { refKey } from '../timeline.ts';
import type { ReviewDossier } from './dossier.ts';
import { MEASUREMENTS, SCREENING_RULES, type ScreeningRule } from './knowledge.ts';
import { foldWithMap } from './text.ts';
import { type Signal, utilizationWindow } from './detectors.ts';
import type { FindingDraft } from './validation.ts';

const DAY_MS = 86_400_000;
/** An expectation due further out than this does not cover a missing check-up. */
export const SCREENING_COVER_DAYS = 90;

/**
 * Every test code that fulfills each expectation, from the clinic's catalog:
 * the item's own code and the literal codes of its `fulfilledBy` filters (a
 * protocol item's equivalence group). Expectations of rules the catalog no
 * longer has keep only their own code.
 */
export function expectationTestCodes(
  catalog: Catalog,
  expectations: readonly Expectation[],
): Map<string, ReadonlySet<string>> {
  const byExpectation = new Map<string, ReadonlySet<string>>();
  for (const expectation of expectations) {
    const definition = catalog.definition(expectation.ruleId);
    if (definition === undefined) continue;
    const codes = new Set<string>();
    if (definition.code !== undefined) codes.add(definition.code.code);
    for (const correlation of definition.fulfilledBy) {
      const listed = correlation.filter?.['code.code'];
      for (const code of Array.isArray(listed) ? listed : []) {
        if (typeof code === 'string') codes.add(code);
      }
    }
    if (codes.size > 0) byExpectation.set(expectation.id, codes);
  }
  return byExpectation;
}

/**
 * Whether the engine already deals with what a finding says: an open
 * expectation (or an expired one in an active case) triggered by the cited
 * result, asking for the same test (any code of its equivalence group: a
 * creatinine trend is covered by the CKD protocol's renal function item),
 * or the protocol item of the same check-up. Decided by code from the
 * engine's own state; whatever the model said about coverage is ignored.
 */
export function coverageOf(
  draft: FindingDraft,
  dossier: ReviewDossier,
  signals: readonly Signal[] = [],
): FindingCoverage[] {
  const { liveExpectations, activeCases, events } = dossier.snapshot;
  const cited = new Set(draft.citations.map((citation) => refKey(citation.source)));
  const citedMeasurements = new Set(
    draft.citations.flatMap((citation) => {
      const document = dossier.documents.get(dossier.handleOf(citation.source) ?? '');
      return document?.measurement === undefined ? [] : [document.measurement];
    }),
  );
  const citedCodes = new Set(
    MEASUREMENTS.filter((measurement) => citedMeasurements.has(measurement.key)).flatMap(
      (measurement) => measurement.loinc,
    ),
  );
  // A result's report lists the Observation that was cited.
  const reportsOfCited = new Set(
    events.flatMap((event) =>
      event.type === 'result.received' &&
      (event.listedResults ?? []).some((listed) => cited.has(refKey(listed)))
        ? [refKey(event.source)]
        : [],
    ),
  );
  // The check-up a finding is about: its detector rule, else words of its text (an added finding).
  const ruleKeys = signals
    .filter((signal) => draft.signalIds.includes(signal.id))
    .map((signal) => signal.rule.replace(/^screening:/, ''));
  const text = foldWithMap(`${draft.summary} ${draft.suggestion}`).folded;
  const screenings = SCREENING_RULES.filter((rule) =>
    ruleKeys.length > 0
      ? ruleKeys.includes(rule.key)
      : rule.coverageTerms.some((term) => text.includes(term)),
  );
  /** The codes of the test an expectation asks for: its own and, from the catalog, its equivalents. */
  const testCodesOf = (expectation: Expectation): Set<string> => {
    const codes = new Set(dossier.snapshot.expectationTestCodes?.get(expectation.id) ?? []);
    const own = parseCodeMatchKey(expectation.matchKey);
    if (own !== undefined) codes.add(own.code);
    return codes;
  };
  const asksFor = (expectation: Expectation, wanted: ReadonlySet<string>): boolean =>
    [...testCodesOf(expectation)].some((code) => wanted.has(code));

  /** A protocol check-up item, or a request of the check-up's own test. */
  const asksForScreening = (expectation: Expectation, rule: ScreeningRule): boolean =>
    rule.coveredByRules.includes(expectation.ruleId) ||
    (rule.key === 'diabetic_fundus' && expectation.matchKey.endsWith('fundus-exam')) ||
    asksFor(expectation, new Set(rule.resultLoinc ?? []));
  /** Due soon enough to count: a check-up next due in ten months does not cover one never done. */
  const dueSoon = (expectation: Expectation): boolean =>
    expectation.dueAt.getTime() <= dossier.snapshot.now.getTime() + SCREENING_COVER_DAYS * DAY_MS;

  const covers = (expectation: Expectation): boolean => {
    switch (draft.category) {
      case 'lab_trend': {
        if (
          cited.has(refKey(expectation.source)) ||
          reportsOfCited.has(refKey(expectation.source))
        ) {
          return true;
        }
        return asksFor(expectation, citedCodes);
      }
      // An abnormal result nobody reviewed is covered only by an action on that
      // very result (the review visit it triggered), never by a routine re-test
      // of the same analyte nor by a visit planned before the result existed.
      case 'abnormal_result_no_followup':
        return (
          (cited.has(refKey(expectation.source)) ||
            reportsOfCited.has(refKey(expectation.source))) &&
          !asksFor(expectation, citedCodes)
        );
      case 'missing_screening':
        return (
          dueSoon(expectation) && screenings.some((rule) => asksForScreening(expectation, rule))
        );
      // Nothing the engine tracks answers these: a drug combination, a symptom, a
      // question or a trend in vital signs is never covered by an expectation.
      case 'vital_trend':
      case 'drug_interaction':
      case 'drug_condition_conflict':
      case 'unaddressed_symptom':
      case 'record_quality':
      case 'utilization_change':
      case 'pre_visit_question':
      case 'similar_patients':
        return false;
    }
  };

  const coverage: FindingCoverage[] = [];
  if (draft.category === 'utilization_change') {
    // Explained when the visits of the window a plan or a protocol asked for
    // account for the change: what is left is not frequent.
    const window = utilizationWindow(dossier);
    return window.frequent
      ? []
      : window.explainedBy.map((expectation) => ({
          kind: 'expectation',
          id: expectation.id,
          code: expectation.ruleId,
        }));
  }
  const live = liveExpectations.filter(
    (expectation) => expectation.status === 'open' || expectation.status === 'expired',
  );
  // A finding about several check-ups is covered only when every one of them is.
  if (
    draft.category === 'missing_screening' &&
    !screenings.every((rule) =>
      live.some((expectation) => dueSoon(expectation) && asksForScreening(expectation, rule)),
    )
  ) {
    return [];
  }
  for (const expectation of live.filter(covers)) {
    coverage.push({ kind: 'expectation', id: expectation.id, code: expectation.ruleId });
    const holder = activeCases.find((item) =>
      item.reasons.some((reason) => reason.expectationId === expectation.id),
    );
    if (holder !== undefined && !coverage.some((item) => item.id === holder.id)) {
      coverage.push({ kind: 'case', id: holder.id, code: expectation.reason.code });
    }
  }
  return coverage;
}
