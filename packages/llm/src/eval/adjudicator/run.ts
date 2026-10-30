import { readFile } from 'node:fs/promises';
import {
  ADJUDICATION_DECISIONS,
  type AdjudicationDecision,
  type AdjudicationInput,
  checkDecision,
  type ClinicId,
  DEFAULT_ADJUDICATOR_SETTINGS,
  type ExpectationAdjudicator,
  PLAN_ITEM_KINDS,
} from '@follow-up-engine/core';
import { z } from 'zod';

/** One hand-labeled ambiguous item of the adjudicator's gold set (synthetic). */
export const AdjudicatorGoldItemSchema = z.object({
  id: z.string(),
  specialty: z.string(),
  kind: z.enum(PLAN_ITEM_KINDS),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  dueInDays: z.number().int(),
  note: z.string(),
  evidenceQuote: z.string(),
  expected: z.enum(ADJUDICATION_DECISIONS),
});
export type AdjudicatorGoldItem = z.infer<typeof AdjudicatorGoldItemSchema>;

const GoldFileSchema = z.object({
  description: z.string(),
  items: z.array(AdjudicatorGoldItemSchema).min(1),
});

/** Reads the gold set; every quote must be in its note (the set is checked, not trusted). */
export async function loadAdjudicatorGold(path: string): Promise<AdjudicatorGoldItem[]> {
  const parsed = GoldFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  for (const item of parsed.items) {
    if (!item.note.includes(item.evidenceQuote)) {
      throw new Error(`Gold item ${item.id}: the quote is not in the note`);
    }
  }
  return parsed.items;
}

const EVAL_CLINIC = 'eval-adjudicator' as ClinicId;

export function goldInput(item: AdjudicatorGoldItem): AdjudicationInput {
  return {
    itemRef: `ITEM-${item.id}`,
    kind: item.kind,
    description: item.description,
    evidenceQuote: item.evidenceQuote,
    extractionConfidence: item.confidence,
    noteDate: '2026-01-05',
    dueInDays: item.dueInDays,
    specialty: item.specialty,
    otherPlanItems: [],
    noteText: item.note,
  };
}

export interface AdjudicatorItemResult {
  readonly id: string;
  readonly expected: AdjudicationDecision;
  /** After the engine's checks (what the clinic would see). */
  readonly decision: AdjudicationDecision;
  readonly modelDecision: AdjudicationDecision;
  readonly probability: number;
  readonly reasonCodes: readonly string[];
  readonly quotesVerified: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface AdjudicatorEvalTotals {
  readonly items: number;
  /** Share of items whose final decision matches the label. */
  readonly accuracy: number;
  /** Share of items whose model decision (before the engine's checks) matches the label. */
  readonly modelAccuracy: number;
  /** Labeled open or discard but decided the opposite way: the costly mistakes. */
  readonly flips: number;
  /** Mean squared error of the probability on the open (1) and discard (0) items. */
  readonly brier: number | undefined;
  /** Items with no quote the engine could find in the note. */
  readonly unverifiedQuotes: number;
  readonly errors: number;
  readonly costUsd: number;
  readonly avgLatencyMs: number;
  /** expected → decided → count. */
  readonly confusion: Readonly<
    Record<AdjudicationDecision, Readonly<Record<AdjudicationDecision, number>>>
  >;
}

export interface AdjudicatorEvalRun {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly items: readonly AdjudicatorItemResult[];
  readonly totals: AdjudicatorEvalTotals;
}

function emptyConfusion(): Record<AdjudicationDecision, Record<AdjudicationDecision, number>> {
  const row = (): Record<AdjudicationDecision, number> => ({ open: 0, discard: 0, needs_human: 0 });
  return { open: row(), discard: row(), needs_human: row() };
}

/**
 * Runs the adjudicator over the gold set the way the engine does: the port
 * (`decide`), then the engine's own checks (`checkDecision`, default
 * thresholds). Items are run one at a time, so a live run stays small.
 */
export async function runAdjudicatorEval(options: {
  readonly items: readonly AdjudicatorGoldItem[];
  readonly adjudicator: ExpectationAdjudicator;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly onItem?: (result: AdjudicatorItemResult) => void;
}): Promise<AdjudicatorEvalRun> {
  const results: AdjudicatorItemResult[] = [];
  for (const item of options.items) {
    let result: AdjudicatorItemResult;
    try {
      const answer = await options.adjudicator.decide(EVAL_CLINIC, {
        input: goldInput(item),
        redactTerms: [],
      });
      const checked = checkDecision(answer, item.note, item.id, DEFAULT_ADJUDICATOR_SETTINGS);
      result = {
        id: item.id,
        expected: item.expected,
        decision: checked.decision,
        modelDecision: answer.decision,
        probability: checked.probability,
        reasonCodes: checked.reasonCodes,
        quotesVerified: checked.quotes.length,
        costUsd: answer.costUsd,
        latencyMs: answer.latencyMs,
      };
    } catch (error) {
      result = {
        id: item.id,
        expected: item.expected,
        decision: 'needs_human',
        modelDecision: 'needs_human',
        probability: 0.5,
        reasonCodes: [],
        quotesVerified: 0,
        costUsd: 0,
        latencyMs: 0,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    results.push(result);
    options.onItem?.(result);
  }
  const confusion = emptyConfusion();
  for (const result of results) confusion[result.expected][result.decision] += 1;
  const binary = results.filter(
    (result) => result.expected !== 'needs_human' && result.error === undefined,
  );
  const brier =
    binary.length === 0
      ? undefined
      : binary.reduce((sum, result) => {
          const label = result.expected === 'open' ? 1 : 0;
          return sum + (result.probability - label) ** 2;
        }, 0) / binary.length;
  const count = results.length;
  return {
    provider: options.provider,
    model: options.model,
    promptVersion: options.promptVersion,
    items: results,
    totals: {
      items: count,
      accuracy: results.filter((result) => result.decision === result.expected).length / count,
      modelAccuracy:
        results.filter((result) => result.modelDecision === result.expected).length / count,
      flips: results.filter(
        (result) =>
          (result.expected === 'open' && result.decision === 'discard') ||
          (result.expected === 'discard' && result.decision === 'open'),
      ).length,
      brier: brier === undefined ? undefined : Math.round(brier * 10_000) / 10_000,
      unverifiedQuotes: results.filter(
        (result) => result.error === undefined && result.quotesVerified === 0,
      ).length,
      errors: results.filter((result) => result.error !== undefined).length,
      costUsd: Math.round(results.reduce((sum, result) => sum + result.costUsd, 0) * 1e6) / 1e6,
      avgLatencyMs: Math.round(results.reduce((sum, result) => sum + result.latencyMs, 0) / count),
      confusion,
    },
  };
}

/** Markdown report of a run (`docs/evals/adjudicator/`). */
export function renderAdjudicatorReport(run: AdjudicatorEvalRun, date: string, note = ''): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)} %`;
  const { totals } = run;
  const rows = ADJUDICATION_DECISIONS.map(
    (expected) =>
      `| ${expected} | ${ADJUDICATION_DECISIONS.map((decided) => String(totals.confusion[expected][decided])).join(' | ')} |`,
  );
  return [
    `# Adjudicator eval: ${run.provider} / ${run.model}`,
    '',
    `Date: ${date}. Prompt: \`${run.promptVersion}\`. Gold set: \`packages/testkit/fixtures/adjudicator-gold/gold.json\` (${String(totals.items)} synthetic ambiguous items).`,
    '',
    ...(note === '' ? [] : [note, '']),
    '| Metric | Value |',
    '| --- | --- |',
    `| Accuracy (after the engine's checks) | ${pct(totals.accuracy)} |`,
    `| Model accuracy (before the checks) | ${pct(totals.modelAccuracy)} |`,
    `| Open ↔ discard flips | ${String(totals.flips)} |`,
    `| Brier score (open/discard items) | ${totals.brier === undefined ? 'n/a' : totals.brier.toFixed(4)} |`,
    `| Items without a verified quote | ${String(totals.unverifiedQuotes)} |`,
    `| Errors | ${String(totals.errors)} |`,
    `| Total cost | $${totals.costUsd.toFixed(6)} |`,
    `| Mean latency | ${String(totals.avgLatencyMs)} ms |`,
    '',
    'Confusion (rows: expected, columns: decided):',
    '',
    '| expected | open | discard | needs_human |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '| Item | Expected | Decided | Model | Probability | Reasons |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.items.map(
      (item) =>
        `| ${item.id} | ${item.expected} | ${item.decision} | ${item.modelDecision} | ${item.probability.toFixed(2)} | ${item.error === undefined ? item.reasonCodes.join(', ') : `error: ${item.error.slice(0, 80)}`} |`,
    ),
    '',
  ].join('\n');
}
