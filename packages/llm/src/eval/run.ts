import type { ClinicId } from '@follow-up-engine/core';
import { describeError } from '../errors.ts';
import type { DetailedNoteExtractor } from '../extraction/note-extractor.ts';
import type { RejectionReason } from '../extraction/types.ts';
import { goldAuthoredAt, type GoldNote } from './gold.ts';
import {
  ZERO_COUNTS,
  addCounts,
  compareExtraction,
  percentile,
  scores,
  type Counts,
  type FieldCounts,
  type Scores,
} from './metrics.ts';

/** Rejections where the quote exists but does not back the item. */
const EVIDENCE_REASONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  'quote_too_short',
  'quote_unrelated',
  'negated',
  'conditional',
  'timing_mismatch',
  'not_a_medication',
]);

export interface NoteResult {
  readonly id: string;
  readonly specialty: string;
  /** Present when the extraction threw (budget, provider down, unrepairable output). */
  readonly error?: string;
  readonly counts: FieldCounts;
  readonly hasPlanCorrect: boolean;
  /** Whether the discharge ("se da de alta") was read as labeled. Optional in older summaries. */
  readonly dischargeCorrect?: boolean;
  readonly modelItemCount: number;
  /** Items dropped because their evidence quote is not in the note. */
  readonly quoteRejected: number;
  /**
   * Items whose quote is in the note but does not back them (too short,
   * unrelated, negated, conditional, contradicting timing, a measurement as
   * a medication). Optional in older summaries.
   */
  readonly evidenceRejected?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface FieldScores {
  readonly conditions: Scores;
  readonly medications: Scores;
  readonly planItems: Scores;
}

export interface Aggregate {
  readonly notes: number;
  readonly errors: number;
  readonly counts: FieldCounts;
  readonly scores: FieldScores;
  readonly hasPlanAccuracy: number;
  readonly dischargeAccuracy: number;
  readonly hallucinatedQuoteRate: number;
  readonly modelItems: number;
  readonly quoteRejected: number;
  readonly evidenceRejected: number;
}

export interface EvalSummary {
  readonly overall: Aggregate;
  readonly bySpecialty: readonly (Aggregate & { readonly specialty: string })[];
  readonly tokens: { readonly inputPerNote: number; readonly outputPerNote: number };
  readonly cost: { readonly totalUsd: number; readonly perNoteUsd: number };
  readonly latencyMs: { readonly p50: number; readonly p95: number };
}

export interface EvalRun {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly results: readonly NoteResult[];
  readonly summary: EvalSummary;
}

const NO_COUNTS: FieldCounts = {
  conditions: ZERO_COUNTS,
  medications: ZERO_COUNTS,
  planItems: ZERO_COUNTS,
};

function sumFieldCounts(results: readonly NoteResult[]): FieldCounts {
  return results.reduce<FieldCounts>(
    (acc, r) => ({
      conditions: addCounts(acc.conditions, r.counts.conditions),
      medications: addCounts(acc.medications, r.counts.medications),
      planItems: addCounts(acc.planItems, r.counts.planItems),
    }),
    NO_COUNTS,
  );
}

/** Micro-averaged scores over a set of notes. */
export function aggregate(results: readonly NoteResult[]): Aggregate {
  const counts = sumFieldCounts(results);
  const modelItems = results.reduce((s, r) => s + r.modelItemCount, 0);
  const quoteRejected = results.reduce((s, r) => s + r.quoteRejected, 0);
  const evidenceRejected = results.reduce((s, r) => s + (r.evidenceRejected ?? 0), 0);
  return {
    notes: results.length,
    errors: results.filter((r) => r.error !== undefined).length,
    counts,
    scores: {
      conditions: scores(counts.conditions),
      medications: scores(counts.medications),
      planItems: scores(counts.planItems),
    },
    hasPlanAccuracy:
      results.length === 0 ? 0 : results.filter((r) => r.hasPlanCorrect).length / results.length,
    dischargeAccuracy:
      results.length === 0
        ? 0
        : results.filter((r) => r.dischargeCorrect !== false).length / results.length,
    hallucinatedQuoteRate: modelItems === 0 ? 0 : quoteRejected / modelItems,
    modelItems,
    quoteRejected,
    evidenceRejected,
  };
}

export function summarize(results: readonly NoteResult[]): EvalSummary {
  const specialties = [...new Set(results.map((r) => r.specialty))].sort();
  const ok = results.filter((r) => r.error === undefined);
  const n = Math.max(1, ok.length);
  const totalUsd = results.reduce((s, r) => s + r.costUsd, 0);
  return {
    overall: aggregate(results),
    bySpecialty: specialties.map((specialty) => ({
      specialty,
      ...aggregate(results.filter((r) => r.specialty === specialty)),
    })),
    tokens: {
      inputPerNote: ok.reduce((s, r) => s + r.inputTokens, 0) / n,
      outputPerNote: ok.reduce((s, r) => s + r.outputTokens, 0) / n,
    },
    cost: { totalUsd, perNoteUsd: totalUsd / Math.max(1, results.length) },
    latencyMs: {
      p50: percentile(
        ok.map((r) => r.latencyMs),
        50,
      ),
      p95: percentile(
        ok.map((r) => r.latencyMs),
        95,
      ),
    },
  };
}

/** Runs `fn` over `items` with at most `concurrency` in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}

export interface RunEvalOptions {
  readonly notes: readonly GoldNote[];
  readonly extractor: DetailedNoteExtractor;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  /** Accounting clinic for the run (synthetic). Never sent to the model. */
  readonly clinicId: ClinicId;
  readonly concurrency?: number;
  readonly onNote?: (result: NoteResult) => void;
  readonly now?: () => Date;
}

/** Extracts every gold note and scores it. Extraction errors are scored as misses, not thrown. */
export async function runExtractionEval(options: RunEvalOptions): Promise<EvalRun> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const results = await mapWithConcurrency(
    options.notes,
    options.concurrency ?? 4,
    async (note) => {
      const authoredAt = goldAuthoredAt(note);
      let result: NoteResult;
      try {
        const extraction = await options.extractor.extract(options.clinicId, {
          documentId: note.id,
          text: note.text,
          specialty: note.specialty,
          authoredAt,
        });
        const compared = compareExtraction(note.expected, extraction, authoredAt);
        result = {
          id: note.id,
          specialty: note.specialty,
          counts: compared,
          hasPlanCorrect: compared.hasPlanCorrect,
          dischargeCorrect: compared.dischargeCorrect,
          modelItemCount: extraction.modelItemCount,
          quoteRejected: extraction.rejected.filter((r) => r.reason === 'quote_not_found').length,
          evidenceRejected: extraction.rejected.filter((r) => EVIDENCE_REASONS.has(r.reason))
            .length,
          inputTokens: extraction.inputTokens,
          outputTokens: extraction.outputTokens,
          costUsd: extraction.costUsd,
          latencyMs: extraction.latencyMs,
        };
      } catch (error) {
        const missed = (items: readonly unknown[]): Counts => ({ tp: 0, fp: 0, fn: items.length });
        result = {
          id: note.id,
          specialty: note.specialty,
          error: describeError(error),
          counts: {
            conditions: missed(note.expected.conditions),
            medications: missed(note.expected.medications),
            planItems: missed(note.expected.planItems),
          },
          hasPlanCorrect: false,
          dischargeCorrect: false,
          modelItemCount: 0,
          quoteRejected: 0,
          evidenceRejected: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 0,
        };
      }
      options.onNote?.(result);
      return result;
    },
  );
  return {
    provider: options.provider,
    model: options.model,
    promptVersion: options.promptVersion,
    startedAt,
    durationMs: now().getTime() - startedAt.getTime(),
    results,
    summary: summarize(results),
  };
}
