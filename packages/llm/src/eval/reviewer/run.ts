import {
  type ClinicalReviewAgent,
  clinicId as toClinicId,
  FINDING_CATEGORIES,
  locateVerbatim,
  reviewRecord,
  type ResourceRef,
  type ReviewOutcome,
} from '@follow-up-engine/core';
import type { CohortRecord } from './cohort.ts';

/** Muse Spark list price (USD per 1M tokens), to project what a fake run would cost on it. */
const MUSE_SPARK_PRICE = { input: 1.25, output: 4.25 } as const;

export interface PatientResult {
  readonly patientId: string;
  readonly kind: 'planted' | 'control';
  readonly story: string;
  readonly expected: readonly { readonly category: string; readonly rule: string }[];
  /** What the review stored: category and the detector rule behind it, if any. */
  readonly found: readonly {
    readonly category: string;
    readonly rule?: string;
    readonly summary: string;
  }[];
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** Citations of stored findings whose quote is not in the cited document. Must be 0. */
  readonly hallucinatedCitations: number;
  readonly citations: number;
  /** Stored findings with their words in both English and Spanish. */
  readonly bilingual: number;
  /** Submissions refused once for a missing translation (the model then resubmitted). */
  readonly translationRequests: number;
  /** Proposals dropped by the engine's checks, by reason. */
  readonly discarded: Readonly<Record<string, number>>;
  readonly signals: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly status: string;
  readonly stopReason: string;
  readonly error?: string;
  readonly latencyMs: number;
}

export interface CategoryScore {
  readonly category: string;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision?: number;
  readonly recall?: number;
}

export interface ReviewerEvalRun {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly startedAt: string;
  readonly patients: readonly PatientResult[];
  readonly byCategory: readonly CategoryScore[];
  readonly totals: {
    readonly truePositives: number;
    readonly falsePositives: number;
    readonly falseNegatives: number;
    readonly precision?: number;
    readonly recall?: number;
    readonly hallucinatedCitations: number;
    readonly citations: number;
    readonly findings: number;
    readonly bilingual: number;
    readonly translationRequests: number;
    readonly controlsWithFindings: number;
    readonly reviews: number;
    readonly degraded: number;
    readonly avgSteps: number;
    readonly avgToolCalls: number;
    readonly avgInputTokens: number;
    readonly avgOutputTokens: number;
    readonly costPerReviewUsd: number;
    readonly projectedMuseSparkCostPerReviewUsd: number;
    readonly discarded: Readonly<Record<string, number>>;
  };
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

/** Findings matched to the planted ones by category, one to one. */
function match(
  expected: readonly { readonly category: string }[],
  found: readonly { readonly category: string }[],
): {
  tp: number;
  fp: number;
  fn: number;
  perCategory: Map<string, { tp: number; fp: number; fn: number }>;
} {
  const perCategory = new Map<string, { tp: number; fp: number; fn: number }>();
  const bump = (category: string, key: 'tp' | 'fp' | 'fn'): void => {
    const current = perCategory.get(category) ?? { tp: 0, fp: 0, fn: 0 };
    current[key] += 1;
    perCategory.set(category, current);
  };
  const remaining = [...found];
  for (const item of expected) {
    const index = remaining.findIndex((candidate) => candidate.category === item.category);
    if (index >= 0) {
      remaining.splice(index, 1);
      bump(item.category, 'tp');
    } else {
      bump(item.category, 'fn');
    }
  }
  for (const extra of remaining) bump(extra.category, 'fp');
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const value of perCategory.values()) {
    tp += value.tp;
    fp += value.fp;
    fn += value.fn;
  }
  return { tp, fp, fn, perCategory };
}

/** Citations of stored findings checked again, independently, against the dossier's documents. */
function hallucinated(outcome: ReviewOutcome): { bad: number; total: number } {
  let bad = 0;
  let total = 0;
  const sameSource = (left: ResourceRef, right: ResourceRef): boolean =>
    left.resourceType === right.resourceType && left.id === right.id;
  for (const finding of outcome.findings) {
    for (const citation of finding.citations) {
      total += 1;
      // Every document of the cited resource: a blood pressure panel is one
      // Observation with a systolic and a diastolic document, and the stored
      // citation keeps only the Observation.
      const documents = [...outcome.dossier.documents.values()].filter((document) =>
        sameSource(document.source, citation.source),
      );
      if (
        !documents.some((document) => locateVerbatim(document.text, citation.quote) !== undefined)
      ) {
        bad += 1;
      }
    }
  }
  return { bad, total };
}

/**
 * Runs the whole review pipeline (dossier, detectors, agent through the
 * gateway, the engine's checks) on every cohort patient with every
 * implemented category enabled, and scores it against what was planted.
 */
export async function runReviewerEval(options: {
  readonly records: readonly CohortRecord[];
  readonly agent?: ClinicalReviewAgent;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly onPatient?: (result: PatientResult) => void;
}): Promise<ReviewerEvalRun> {
  const startedAt = new Date().toISOString();
  const patients: PatientResult[] = [];
  const categoryTotals = new Map<string, { tp: number; fp: number; fn: number }>();
  for (const record of options.records) {
    const started = performance.now();
    const outcome = await reviewRecord(toClinicId('clinic-eval'), record.snapshot, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      enabled: (category) => category !== 'similar_patients',
      redactTerms: record.redactTerms,
      patientRef: `P-${record.patient.patientId.slice(-4)}`,
    });
    const latencyMs = Math.round(performance.now() - started);
    const ruleOf = new Map(outcome.signals.map((signal) => [signal.id, signal.rule]));
    const found = outcome.findings.map((finding) => {
      const rule = finding.signalIds.map((id) => ruleOf.get(id)).find((item) => item !== undefined);
      return {
        category: finding.category,
        ...(rule === undefined ? {} : { rule }),
        summary: finding.summary,
      };
    });
    const { tp, fp, fn, perCategory } = match(record.patient.expected, found);
    for (const [category, counts] of perCategory) {
      const total = categoryTotals.get(category) ?? { tp: 0, fp: 0, fn: 0 };
      total.tp += counts.tp;
      total.fp += counts.fp;
      total.fn += counts.fn;
      categoryTotals.set(category, total);
    }
    const citations = hallucinated(outcome);
    const result: PatientResult = {
      patientId: record.patient.patientId,
      kind: record.patient.kind,
      story: record.patient.story,
      expected: record.patient.expected.map((item) => ({
        category: item.category,
        rule: item.rule,
      })),
      found,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      hallucinatedCitations: citations.bad,
      citations: citations.total,
      bilingual: outcome.findings.filter(
        (finding) => finding.texts?.en !== undefined && finding.texts.es !== undefined,
      ).length,
      translationRequests: (outcome.agent?.trace ?? []).filter(
        (step) => step.outcome === 'missing_translation',
      ).length,
      discarded: { ...outcome.discarded },
      signals: outcome.signals.length,
      steps: outcome.agent?.steps ?? 0,
      toolCalls: outcome.agent?.toolCalls ?? 0,
      inputTokens: outcome.agent?.inputTokens ?? 0,
      outputTokens: outcome.agent?.outputTokens ?? 0,
      costUsd: outcome.agent?.costUsd ?? 0,
      status: outcome.status,
      stopReason: outcome.stopReason,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      latencyMs,
    };
    patients.push(result);
    options.onPatient?.(result);
  }

  const byCategory: CategoryScore[] = FINDING_CATEGORIES.filter((category) =>
    categoryTotals.has(category),
  ).map((category) => {
    const counts = categoryTotals.get(category) ?? { tp: 0, fp: 0, fn: 0 };
    const precision = ratio(counts.tp, counts.tp + counts.fp);
    const recall = ratio(counts.tp, counts.tp + counts.fn);
    return {
      category,
      truePositives: counts.tp,
      falsePositives: counts.fp,
      falseNegatives: counts.fn,
      ...(precision === undefined ? {} : { precision }),
      ...(recall === undefined ? {} : { recall }),
    };
  });
  const sum = (pick: (result: PatientResult) => number): number =>
    patients.reduce((total, result) => total + pick(result), 0);
  const reviews = patients.length;
  const tp = sum((result) => result.truePositives);
  const fp = sum((result) => result.falsePositives);
  const fn = sum((result) => result.falseNegatives);
  const discarded: Record<string, number> = {};
  for (const result of patients) {
    for (const [reason, count] of Object.entries(result.discarded)) {
      discarded[reason] = (discarded[reason] ?? 0) + count;
    }
  }
  const avg = (value: number): number => (reviews === 0 ? 0 : value / reviews);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    provider: options.provider,
    model: options.model,
    promptVersion: options.promptVersion,
    startedAt,
    patients,
    byCategory,
    totals: {
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      ...(precision === undefined ? {} : { precision }),
      ...(recall === undefined ? {} : { recall }),
      hallucinatedCitations: sum((result) => result.hallucinatedCitations),
      citations: sum((result) => result.citations),
      findings: sum((result) => result.found.length),
      bilingual: sum((result) => result.bilingual),
      translationRequests: sum((result) => result.translationRequests),
      controlsWithFindings: patients.filter(
        (result) => result.kind === 'control' && result.found.length > 0,
      ).length,
      reviews,
      degraded: patients.filter((result) => result.status === 'degraded').length,
      avgSteps: avg(sum((result) => result.steps)),
      avgToolCalls: avg(sum((result) => result.toolCalls)),
      avgInputTokens: avg(sum((result) => result.inputTokens)),
      avgOutputTokens: avg(sum((result) => result.outputTokens)),
      costPerReviewUsd: avg(sum((result) => result.costUsd)),
      projectedMuseSparkCostPerReviewUsd: avg(
        sum(
          (result) =>
            (result.inputTokens * MUSE_SPARK_PRICE.input +
              result.outputTokens * MUSE_SPARK_PRICE.output) /
            1_000_000,
        ),
      ),
      discarded,
    },
  };
}
