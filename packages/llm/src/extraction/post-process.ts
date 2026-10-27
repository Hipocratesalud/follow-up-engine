import { ICD10_SYSTEM, type PlanItem } from '@follow-up-engine/core';
import { durationInDays, resolveDueAt } from './due-date.ts';
import { locateQuote, normalizeForMatch } from './quote.ts';
import type { ModelExtraction } from './schema.ts';
import type { ExtractedCondition, ExtractedMedication, RejectedItem } from './types.ts';

export interface PostProcessed {
  readonly hasPlan: boolean;
  readonly conditions: readonly ExtractedCondition[];
  readonly medications: readonly ExtractedMedication[];
  readonly planItems: readonly PlanItem[];
  readonly rejected: readonly RejectedItem[];
  readonly modelItemCount: number;
}

/** Clamps a model confidence to [0, 1]; anything that is not a finite number becomes 0. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalizes an ICD-10 code (`e11.9`, `E119`, ` E11 ` -> `E11.9`, `E11.9`, `E11`).
 * Returns `undefined` when it is not shaped like ICD-10.
 */
export function normalizeIcd10(raw: string): string | undefined {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, '');
  const match = /^([A-Z]\d[0-9A-Z])\.?([0-9A-Z]{1,4})?$/.exec(compact);
  if (!match?.[1]) return undefined;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

export const LOINC_SYSTEM = 'http://loinc.org';

/**
 * Whether a LOINC code is well formed and its mod-10 check digit is right
 * (https://loinc.org/kb/faq/structure/). Catches most invented codes.
 */
export function isValidLoinc(code: string): boolean {
  const match = /^(\d{1,7})-(\d)$/.exec(code);
  const base = match?.[1];
  if (base === undefined || match?.[2] === undefined) return false;
  // Digits from the right: odd positions form a number that is doubled,
  // even positions are prepended, and the check digit tops the digit sum up
  // to a multiple of ten.
  let odd = '';
  let even = '';
  for (let i = base.length - 1, position = 1; i >= 0; i -= 1, position += 1) {
    if (position % 2 === 1) odd += base.charAt(i);
    else even += base.charAt(i);
  }
  const combined = `${even}${String(Number(odd) * 2)}`;
  let sum = 0;
  for (let i = 0; i < combined.length; i += 1) sum += Number(combined.charAt(i));
  return (10 - (sum % 10)) % 10 === Number(match[2]);
}

function normalizeLoinc(code: string | null): string | undefined {
  const trimmed = code?.trim();
  return trimmed && isValidLoinc(trimmed) ? trimmed : undefined;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic checks between the model and the domain:
 *
 * - every item must carry an evidence quote that really occurs in the note
 *   (normalized match), and the stored quote is the verbatim span of the note;
 * - ICD-10 codes must be well formed;
 * - plan due dates are computed here from `authoredAt`, never by the model;
 *   an untimed lab or imaging item inherits the earliest follow-up visit of
 *   the same note ("traer HbA1c al próximo control"), otherwise it is dropped;
 * - confidences are clamped to [0, 1];
 * - duplicates are removed (same code, same medication, same kind + day + description).
 *
 * Every dropped item is reported with its reason, which the eval harness uses
 * to measure the hallucinated-quote rate.
 */
export function postProcessExtraction(
  raw: ModelExtraction,
  note: { readonly text: string; readonly authoredAt: Date },
): PostProcessed {
  const rejected: RejectedItem[] = [];
  const reject = (
    field: RejectedItem['field'],
    reason: RejectedItem['reason'],
    quote: string,
  ): void => {
    rejected.push({ field, reason, evidenceQuote: quote });
  };

  const conditionsByCode = new Map<string, ExtractedCondition>();
  for (const item of raw.conditions) {
    const quote = locateQuote(note.text, item.evidenceQuote);
    if (quote === undefined) {
      reject('condition', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const code = normalizeIcd10(item.icd10);
    if (code === undefined) {
      reject('condition', 'invalid_code', item.evidenceQuote);
      continue;
    }
    const display = item.display.trim();
    const condition: ExtractedCondition = {
      code: { system: ICD10_SYSTEM, code, ...(display ? { display } : {}) },
      confidence: clampConfidence(item.confidence),
      evidenceQuote: quote,
    };
    const existing = conditionsByCode.get(code);
    if (existing) {
      reject('condition', 'duplicate', item.evidenceQuote);
      if (condition.confidence > existing.confidence) conditionsByCode.set(code, condition);
      continue;
    }
    conditionsByCode.set(code, condition);
  }

  const medications: ExtractedMedication[] = [];
  const medicationKeys = new Set<string>();
  for (const item of raw.medications) {
    const text = item.text.trim();
    if (text === '') {
      reject('medication', 'empty_text', item.evidenceQuote);
      continue;
    }
    const quote = locateQuote(note.text, item.evidenceQuote);
    if (quote === undefined) {
      reject('medication', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const key = normalizeForMatch(text);
    if (medicationKeys.has(key)) {
      reject('medication', 'duplicate', item.evidenceQuote);
      continue;
    }
    medicationKeys.add(key);
    const days =
      item.duration && Number.isFinite(item.duration.amount) && item.duration.amount > 0
        ? durationInDays(item.duration.amount, item.duration.unit)
        : undefined;
    medications.push({ text, evidenceQuote: quote, ...(days ? { durationDays: days } : {}) });
  }

  // Plan items: quote check and explicit timing first, then untimed items
  // inherit the earliest follow-up visit, then dedupe.
  interface Candidate {
    readonly item: ModelExtraction['planItems'][number];
    readonly quote: string;
    dueAt?: Date;
  }
  const candidates: Candidate[] = [];
  for (const item of raw.planItems) {
    const quote = locateQuote(note.text, item.evidenceQuote);
    if (quote === undefined) {
      reject('planItem', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const resolution = resolveDueAt(note.authoredAt, item.timing);
    if (resolution.ok) {
      candidates.push({ item, quote, dueAt: resolution.dueAt });
    } else if (resolution.reason === 'due_before_note') {
      reject('planItem', 'due_before_note', item.evidenceQuote);
    } else {
      candidates.push({ item, quote });
    }
  }
  const nextVisit = candidates
    .flatMap((c) => (c.item.kind === 'follow_up_visit' && c.dueAt ? [c.dueAt] : []))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const planItems: PlanItem[] = [];
  const planKeys = new Set<string>();
  for (const candidate of candidates) {
    const { item } = candidate;
    const inherits = item.kind === 'lab' || item.kind === 'imaging';
    const dueAt = candidate.dueAt ?? (inherits ? nextVisit : undefined);
    if (!dueAt) {
      reject('planItem', 'no_due_date', item.evidenceQuote);
      continue;
    }
    const description = item.description.trim() || item.kind.replaceAll('_', ' ');
    const key = `${item.kind}|${utcDay(dueAt)}|${normalizeForMatch(description)}`;
    if (planKeys.has(key)) {
      reject('planItem', 'duplicate', item.evidenceQuote);
      continue;
    }
    planKeys.add(key);
    const loinc = item.kind === 'lab' ? normalizeLoinc(item.loincCode) : undefined;
    planItems.push({
      kind: item.kind,
      description,
      dueAt,
      evidenceQuote: candidate.quote,
      confidence: clampConfidence(item.confidence),
      ...(loinc ? { code: { system: LOINC_SYSTEM, code: loinc } } : {}),
    });
  }

  return {
    hasPlan: raw.hasPlan || planItems.length > 0,
    conditions: [...conditionsByCode.values()],
    medications,
    planItems,
    rejected,
    modelItemCount: raw.conditions.length + raw.medications.length + raw.planItems.length,
  };
}
