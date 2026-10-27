import type { FindingCoverage } from '../../domain/clinical-finding.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { parseCodeMatchKey } from '../matching/match-key.ts';
import { refKey } from '../timeline.ts';
import type { ReviewDossier } from './dossier.ts';
import { MEASUREMENTS, SCREENING_RULES } from './knowledge.ts';
import { foldWithMap } from './text.ts';
import type { Signal } from './detectors.ts';
import type { FindingDraft } from './validation.ts';

/**
 * Whether the engine already deals with what a finding says: an open
 * expectation (or an expired one in an active case) triggered by the cited
 * result, asking for the same test, or the protocol item of the same
 * check-up. Decided by code from the engine's own state; whatever the model
 * said about coverage is ignored.
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
  const screeningRules = SCREENING_RULES.filter((rule) =>
    ruleKeys.length > 0
      ? ruleKeys.includes(rule.key)
      : rule.coverageTerms.some((term) => text.includes(term)),
  ).flatMap((rule) => rule.coveredByRules);

  const covers = (expectation: Expectation): boolean => {
    switch (draft.category) {
      case 'lab_trend':
      case 'abnormal_result_no_followup': {
        if (
          cited.has(refKey(expectation.source)) ||
          reportsOfCited.has(refKey(expectation.source))
        ) {
          return true;
        }
        const code = parseCodeMatchKey(expectation.matchKey);
        return code !== undefined && citedCodes.has(code.code);
      }
      case 'missing_screening':
        return (
          screeningRules.includes(expectation.ruleId) ||
          (screeningRules.length > 0 && expectation.matchKey.endsWith('fundus-exam'))
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
  const live = liveExpectations.filter(
    (expectation) => expectation.status === 'open' || expectation.status === 'expired',
  );
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
