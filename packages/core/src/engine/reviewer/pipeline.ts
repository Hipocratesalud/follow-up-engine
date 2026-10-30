import {
  DEFAULT_REVIEW_LOCALE,
  type DiscardReason,
  type FindingCategory,
  type FindingCoverage,
  type FindingText,
  type FindingTexts,
  IMPLEMENTED_FINDING_CATEGORIES,
  REVIEW_LOCALES,
  type ReviewLocale,
  type ReviewRunStatus,
} from '../../domain/clinical-finding.ts';
import type { ClinicId } from '../../domain/ids.ts';
import {
  type ClinicalReviewAgent,
  DEFAULT_REVIEW_LIMITS,
  type ProposedFinding,
  type ReviewAgentResult,
  type ReviewLimits,
} from '../../ports/clinical-review-agent.ts';
import { coverageOf } from './coverage.ts';
import { detectSignals, type Signal, signalView } from './detectors.ts';
import {
  buildDossier,
  type PatientRecordSnapshot,
  type ReviewDossier,
  reviewInputOf,
} from './dossier.ts';
import { createReviewToolbox } from './tools.ts';
import { checkProposal, type FindingDraft } from './validation.ts';

/** Whether a category is enabled for a specialty (`undefined`: the clinic-wide flag). */
export type CategoryGate = (category: FindingCategory, specialty: string | undefined) => boolean;

export interface ReviewOptions {
  /** The agent; without one the review stores the detector signals as they are. */
  readonly agent?: ClinicalReviewAgent;
  readonly enabled: CategoryGate;
  readonly limits?: ReviewLimits;
  /** The patient's names and identifiers, masked in everything sent to the model. */
  readonly redactTerms?: readonly string[];
  /** Per-review pseudonym the model sees instead of any identifier. */
  readonly patientRef: string;
  /** Language of the findings (the clinic's locale). Default `en`. */
  readonly locale?: ReviewLocale;
}

export interface ReviewedFinding extends FindingDraft {
  readonly alreadyCovered: boolean;
  readonly coveredBy: readonly FindingCoverage[];
}

export interface ReviewOutcome {
  readonly dossier: ReviewDossier;
  readonly signals: readonly Signal[];
  readonly findings: readonly ReviewedFinding[];
  /** Proposals (or fallback signals) that did not pass, by reason. */
  readonly discarded: Readonly<Partial<Record<DiscardReason, number>>>;
  readonly status: Exclude<ReviewRunStatus, 'failed'>;
  /** `submitted`, `step_limit`, `token_budget`, `llm_budget`, `error`, `detectors_only` or `no_enabled_category`. */
  readonly stopReason: string;
  readonly agent?: ReviewAgentResult;
  /** Log-safe error name and message when the agent failed. */
  readonly error?: string;
}

function asProposal(signal: Signal): ProposedFinding {
  return {
    category: signal.category,
    severity: signal.severity,
    summary: signal.summary,
    rationale: signal.rationale,
    suggestion: signal.suggestion,
    citations: signal.evidence.map((item) => ({ docId: item.handle, quote: item.quote })),
    signalIds: [signal.id],
    ...(signal.texts === undefined ? {} : { texts: signal.texts }),
  };
}

function textOf(item: FindingText): FindingText {
  return { summary: item.summary, rationale: item.rationale, suggestion: item.suggestion };
}

/**
 * The detector signals with their words in every review locale: the same
 * detectors over the same record, rendered with each locale's templates
 * (the dossier's handles and the detectors' order do not depend on the
 * language; a twin of another rule is never taken).
 */
function withTexts(
  snapshot: PatientRecordSnapshot,
  locale: ReviewLocale,
  signals: readonly Signal[],
  enabled: (category: FindingCategory) => boolean,
): Signal[] {
  const others = REVIEW_LOCALES.filter((item) => item !== locale).map(
    (other) => [other, detectSignals(buildDossier(snapshot, other), enabled)] as const,
  );
  return signals.map((signal, index) => {
    const texts: Partial<Record<ReviewLocale, FindingText>> = { [locale]: textOf(signal) };
    for (const [other, list] of others) {
      const twin = list[index];
      if (twin?.rule === signal.rule && twin.category === signal.category) {
        texts[other] = textOf(twin);
      }
    }
    return { ...signal, texts };
  });
}

/** A draft's words per locale, the clinic's own locale always being the stored text. */
function draftTexts(
  draft: FindingDraft,
  locale: ReviewLocale,
  signals: readonly Signal[],
): FindingTexts {
  const own = textOf(draft);
  // A detector signal stored as is (no agent, or the agent's very words): its other renderings.
  const twin =
    draft.texts === undefined && draft.signalIds.length === 1
      ? signals.find((signal) => signal.id === draft.signalIds[0])
      : undefined;
  const inherited =
    twin?.texts !== undefined &&
    twin.summary === draft.summary &&
    twin.suggestion === draft.suggestion
      ? twin.texts
      : undefined;
  return { ...(draft.texts ?? inherited), [locale]: own };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/**
 * Reviews one patient's record: builds the dossier, runs the deterministic
 * detectors, lets the agent confirm, discard, merge or add findings through
 * its read-only tools, then checks every proposal against the record
 * (citations verbatim, category enabled, never addressed to the patient)
 * and decides coverage by code. Pure apart from the agent call; when the
 * agent cannot finish, the detector signals go through the same checks
 * instead (never blocks).
 */
export async function reviewRecord(
  clinicId: ClinicId,
  snapshot: PatientRecordSnapshot,
  options: ReviewOptions,
): Promise<ReviewOutcome> {
  const locale = options.locale ?? DEFAULT_REVIEW_LOCALE;
  const dossier = buildDossier(snapshot, locale);
  const specialties: (string | undefined)[] = [undefined, ...dossier.specialties];
  const enabledForPatient = (category: FindingCategory): boolean =>
    specialties.some((specialty) => options.enabled(category, specialty));
  if (!IMPLEMENTED_FINDING_CATEGORIES.some(enabledForPatient)) {
    return {
      dossier,
      signals: [],
      findings: [],
      discarded: {},
      status: 'skipped',
      stopReason: 'no_enabled_category',
    };
  }
  const signals = withTexts(
    snapshot,
    locale,
    detectSignals(dossier, enabledForPatient),
    enabledForPatient,
  );

  let proposals: readonly ProposedFinding[] | undefined;
  let agent: ReviewAgentResult | undefined;
  let stopReason = 'detectors_only';
  let error: string | undefined;
  if (options.agent !== undefined) {
    const documents = new Map(
      [...dossier.documents].map(([handle, document]) => [handle, document.text]),
    );
    try {
      agent = await options.agent.review(clinicId, {
        input: reviewInputOf(dossier, options.patientRef, signals.map(signalView)),
        toolbox: createReviewToolbox(dossier),
        limits: options.limits ?? DEFAULT_REVIEW_LIMITS,
        redactTerms: options.redactTerms ?? [],
        documents,
        locale,
      });
      stopReason = agent.stopReason;
      if (agent.stopReason === 'submitted') proposals = agent.proposals;
    } catch (caught) {
      error = describeError(caught);
      stopReason =
        caught instanceof Error && caught.name === 'LlmBudgetExceededError'
          ? 'llm_budget'
          : 'error';
    }
  }
  const degraded = proposals === undefined;
  const candidates = proposals ?? signals.map(asProposal);

  const discarded: Partial<Record<DiscardReason, number>> = {};
  const count = (reason: DiscardReason): void => {
    discarded[reason] = (discarded[reason] ?? 0) + 1;
  };
  const knownSignals = new Set(signals.map((signal) => signal.id));
  const signalRules = new Map(signals.map((signal) => [signal.id, signal.rule]));
  const findings: ReviewedFinding[] = [];
  for (const proposal of candidates) {
    const check = checkProposal(proposal, dossier, {
      enabled: options.enabled,
      knownSignals,
      signalRules,
    });
    if (!check.ok) {
      count(check.reason);
      continue;
    }
    if (findings.some((finding) => finding.dedupKey === check.draft.dedupKey)) {
      count('merged');
      continue;
    }
    const checked = { ...check.draft, texts: draftTexts(check.draft, locale, signals) };
    const draft = degraded ? { ...checked, origin: 'fallback' as const } : checked;
    const coveredBy = coverageOf(draft, dossier, signals);
    findings.push({ ...draft, alreadyCovered: coveredBy.length > 0, coveredBy });
  }
  return {
    dossier,
    signals,
    findings,
    discarded,
    status: options.agent === undefined || !degraded ? 'completed' : 'degraded',
    stopReason,
    ...(agent === undefined ? {} : { agent }),
    ...(error === undefined ? {} : { error }),
  };
}
