import { daysBetween } from '../extraction/due-date.ts';
import type { ExpectedExtraction } from '../extraction/fixtures.ts';
import { normalizeForMatch } from '../extraction/quote.ts';
import type { NoteExtraction } from '../extraction/types.ts';

export interface Counts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

export interface Scores {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export const ZERO_COUNTS: Counts = { tp: 0, fp: 0, fn: 0 };

export function addCounts(a: Counts, b: Counts): Counts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

/**
 * Precision, recall and F1 from counts. An empty denominator scores 1
 * (nothing predicted and nothing missed is perfect), so a correct "no
 * plan" note does not drag averages down.
 */
export function scores(counts: Counts): Scores {
  const precision = counts.tp + counts.fp === 0 ? 1 : counts.tp / (counts.tp + counts.fp);
  const recall = counts.tp + counts.fn === 0 ? 1 : counts.tp / (counts.tp + counts.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * One-to-one matching: each expected item takes the best still-unmatched
 * prediction (lowest `distance`, `undefined` meaning "no match").
 */
export function matchCounts<TExpected, TPredicted>(
  expected: readonly TExpected[],
  predicted: readonly TPredicted[],
  distance: (e: TExpected, p: TPredicted) => number | undefined,
): Counts {
  const used = new Set<number>();
  let tp = 0;
  for (const e of expected) {
    let best: { index: number; d: number } | undefined;
    predicted.forEach((p, index) => {
      if (used.has(index)) return;
      const d = distance(e, p);
      if (d !== undefined && (!best || d < best.d)) best = { index, d };
    });
    if (best) {
      used.add(best.index);
      tp += 1;
    }
  }
  return { tp, fp: predicted.length - tp, fn: expected.length - tp };
}

/** ICD-10 category: first three characters, uppercase, no dot. */
export function icd10Category(code: string): string {
  return code.trim().toUpperCase().replace('.', '').slice(0, 3);
}

/** Whether a predicted plan due date is within ±20% of the expected one (at least ±1 day). */
export function dueDaysMatch(expectedDays: number, predictedDays: number): boolean {
  const tolerance = Math.max(1, Math.abs(expectedDays) * 0.2);
  return Math.abs(predictedDays - expectedDays) <= tolerance;
}

export function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

/** The drug name of a medication line: its first word, normalized ("Losartán 50 mg" -> "losartan"). */
export function drugName(text: string): string {
  return /[a-z]+/.exec(normalizeForMatch(text))?.[0] ?? '';
}

/** Fuzzy medication match: same drug name, allowing up to two typos for names longer than five letters. */
export function medicationsMatch(expected: string, predicted: string): boolean {
  const a = drugName(expected);
  const b = drugName(predicted);
  if (a === '' || b === '') return false;
  return a === b || (a.length > 5 && levenshtein(a, b) <= 2);
}

export interface FieldCounts {
  readonly conditions: Counts;
  readonly medications: Counts;
  readonly planItems: Counts;
}

/** Scores one extraction against the gold expectation. */
export function compareExtraction(
  expected: ExpectedExtraction,
  actual: Pick<NoteExtraction, 'conditions' | 'medications' | 'planItems' | 'hasPlan'>,
  authoredAt: Date,
): FieldCounts & { readonly hasPlanCorrect: boolean } {
  const conditions = matchCounts(expected.conditions, actual.conditions, (e, p) =>
    icd10Category(e.icd10) === icd10Category(p.code.code) ? 0 : undefined,
  );
  const medications = matchCounts(expected.medications, actual.medications, (e, p) =>
    medicationsMatch(e.text, p.text) ? 0 : undefined,
  );
  const planItems = matchCounts(expected.planItems, actual.planItems, (e, p) => {
    if (e.kind !== p.kind) return undefined;
    const days = daysBetween(authoredAt, p.dueAt);
    return dueDaysMatch(e.dueInDays, days) ? Math.abs(days - e.dueInDays) : undefined;
  });
  return {
    conditions,
    medications,
    planItems,
    hasPlanCorrect: expected.hasPlan === actual.hasPlan,
  };
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}
