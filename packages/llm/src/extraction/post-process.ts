import { ICD10_SYSTEM, type PlanItem } from '@follow-up-engine/core';
import { DEFAULT_CONDITION_TERMS, type ConditionTermTable } from './condition-terms.ts';
import { daysBetween, durationInDays, parseIsoDate, resolveDueAt } from './due-date.ts';
import { prepareNote, type PreparedNote } from './prepare.ts';
import { createQuoteIndex, normalizeForMatch, type QuoteSpan } from './quote.ts';
import type { ModelExtraction } from './schema.ts';
import {
  approxDays,
  clauseAround,
  clauseBoundsAround,
  findDischarge,
  forwardIntervals,
  hasKindKeyword,
  hasTimeExpression,
  isConditional,
  isHedgedMention,
  isNegatedMention,
  looksLikeMeasurement,
  segmentAround,
  termsPattern,
  writtenDates,
} from './signals.ts';
import type { ExtractedCondition, ExtractedMedication, RejectedItem } from './types.ts';

export interface PostProcessed {
  readonly hasPlan: boolean;
  readonly conditions: readonly ExtractedCondition[];
  readonly medications: readonly ExtractedMedication[];
  readonly planItems: readonly PlanItem[];
  readonly discharged: boolean;
  readonly dischargeEvidenceQuote?: string;
  readonly rejected: readonly RejectedItem[];
  readonly modelItemCount: number;
}

/**
 * Highest confidence the engine ever attaches to a model item. The model's
 * own number is self-reported, so it is clamped, then lowered further by
 * what the code can check in the note.
 */
export const MAX_ITEM_CONFIDENCE = 0.9;
/** A condition the note only suspects ("sospecha de", "en estudio"): below every engine threshold. */
export const HEDGED_CONDITION_CONFIDENCE = 0.4;
/** A plan item whose timing is stated elsewhere in the note, not where it is quoted. */
export const DETACHED_TIMING_CONFIDENCE = 0.7;
/** An untimed lab or imaging item that inherits the next follow-up visit. */
export const INHERITED_TIMING_CONFIDENCE = 0.8;

/** Fewest letters or digits a quote needs to back anything. */
const MIN_QUOTE_ALNUM = 2;
const MIN_PLAN_QUOTE_ALNUM = 4;
/** Relative tolerance between the model's interval and the one written in the note. */
const TIMING_TOLERANCE = 0.25;

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

function alnumCount(normalized: string): number {
  return normalized.replace(/[^a-z0-9]/g, '').length;
}

const termPatterns = new WeakMap<ConditionTermTable, Map<string, RegExp>>();

/** The compiled term pattern of an ICD-10 category, or `undefined` when the table has none. */
function conditionPattern(table: ConditionTermTable, category: string): RegExp | undefined {
  let compiled = termPatterns.get(table);
  if (!compiled) {
    compiled = new Map();
    for (const [code, terms] of Object.entries(table)) {
      compiled.set(code.toUpperCase(), termsPattern(terms.map(normalizeForMatch)));
    }
    termPatterns.set(table, compiled);
  }
  return compiled.get(category);
}

function firstMatch(pattern: RegExp | undefined, text: string): RegExpExecArray | null {
  if (!pattern) return null;
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match;
}

export interface PostProcessOptions {
  /** Terms that can back each ICD-10 category. Defaults to {@link DEFAULT_CONDITION_TERMS}. */
  readonly conditionTerms?: ConditionTermTable;
}

/** The note as the model read it, or a plain note (then nothing was masked). */
export type PostProcessNote =
  | { readonly text: string; readonly authoredAt: Date }
  | { readonly prepared: PreparedNote; readonly authoredAt: Date };

/**
 * Deterministic checks between the model and the domain. The model's output
 * is untrusted (it may hallucinate, or obey an instruction injected in the
 * note), so an item survives only if the note itself backs it:
 *
 * - every quote must occur in the note (normalized match); the stored quote
 *   is the verbatim span of the original note;
 * - a quote must say something: a condition quote contains a term linked to
 *   its ICD-10 category (`condition-terms.ts`), a medication quote contains
 *   the drug's name, a plan quote contains the item's wording ("ctrl",
 *   "HbA1c", "eco") or its timing ("en 3 meses");
 * - denied conditions ("niega HTA") are dropped, suspected ones get a
 *   confidence below every engine threshold; measurements are never
 *   medications; conditional returns ("volver si fiebre") are not plan;
 * - plan due dates are computed here from `authoredAt`, never by the model,
 *   and only from timing the note states where the item is quoted (or, with
 *   a lower confidence, elsewhere in the note); an interval that contradicts
 *   the quoted one is rejected; an untimed lab or imaging item inherits the
 *   earliest follow-up visit ("traer HbA1c al proximo control");
 * - confidences are the model's, clamped to {@link MAX_ITEM_CONFIDENCE} and
 *   capped by those checks;
 * - a discharge needs a quote that states one ("se da de alta");
 * - duplicates are removed.
 *
 * Every dropped item is reported with its reason.
 */
export function postProcessExtraction(
  raw: ModelExtraction,
  note: PostProcessNote,
  options: PostProcessOptions = {},
): PostProcessed {
  const prepared =
    'prepared' in note ? note.prepared : prepareNote(note.text, { maxChars: Infinity });
  const terms = options.conditionTerms ?? DEFAULT_CONDITION_TERMS;
  const index = createQuoteIndex(prepared.text);
  const noteText = index.normalized.text;
  const rejected: RejectedItem[] = [];
  const reject = (
    field: RejectedItem['field'],
    reason: RejectedItem['reason'],
    quote: string,
  ): void => {
    rejected.push({ field, reason, evidenceQuote: quote });
  };
  const verbatim = (span: QuoteSpan): string => {
    const range = prepared.toOriginal(span.start, span.end);
    return prepared.original.slice(range.start, range.end);
  };
  const quoteText = (span: QuoteSpan): string =>
    noteText.slice(span.normalizedStart, span.normalizedEnd);

  // Conditions
  const conditionsByCode = new Map<string, ExtractedCondition>();
  for (const item of raw.conditions) {
    const span = index.locate(item.evidenceQuote);
    if (span === undefined) {
      reject('condition', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const quote = quoteText(span);
    if (alnumCount(quote) < MIN_QUOTE_ALNUM) {
      reject('condition', 'quote_too_short', item.evidenceQuote);
      continue;
    }
    const code = normalizeIcd10(item.icd10);
    if (code === undefined) {
      reject('condition', 'invalid_code', item.evidenceQuote);
      continue;
    }
    const term = firstMatch(conditionPattern(terms, code.slice(0, 3)), quote);
    if (!term) {
      reject('condition', 'quote_unrelated', item.evidenceQuote);
      continue;
    }
    const termStart = span.normalizedStart + term.index;
    const termEnd = termStart + term[0].length;
    if (isNegatedMention(noteText, termStart, termEnd)) {
      reject('condition', 'negated', item.evidenceQuote);
      continue;
    }
    const cap = isHedgedMention(noteText, termStart, termEnd)
      ? HEDGED_CONDITION_CONFIDENCE
      : MAX_ITEM_CONFIDENCE;
    const display = item.display.trim();
    const condition: ExtractedCondition = {
      code: { system: ICD10_SYSTEM, code, ...(display ? { display } : {}) },
      confidence: Math.min(cap, clampConfidence(item.confidence)),
      evidenceQuote: verbatim(span),
    };
    const existing = conditionsByCode.get(code);
    if (existing) {
      reject('condition', 'duplicate', item.evidenceQuote);
      if (condition.confidence > existing.confidence) conditionsByCode.set(code, condition);
      continue;
    }
    conditionsByCode.set(code, condition);
  }

  // Medications
  const medications: ExtractedMedication[] = [];
  const medicationKeys = new Set<string>();
  for (const item of raw.medications) {
    const text = item.text.trim();
    if (text === '') {
      reject('medication', 'empty_text', item.evidenceQuote);
      continue;
    }
    const span = index.locate(item.evidenceQuote);
    if (span === undefined) {
      reject('medication', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const quote = quoteText(span);
    if (alnumCount(quote) < MIN_PLAN_QUOTE_ALNUM) {
      reject('medication', 'quote_too_short', item.evidenceQuote);
      continue;
    }
    const key = normalizeForMatch(text);
    if (looksLikeMeasurement(key) || looksLikeMeasurement(quote)) {
      reject('medication', 'not_a_medication', item.evidenceQuote);
      continue;
    }
    const names = key.split(/[^a-z]+/).filter((word) => word.length >= 4);
    if (!names.some((name) => quote.includes(name))) {
      reject('medication', 'quote_unrelated', item.evidenceQuote);
      continue;
    }
    if (medicationKeys.has(key)) {
      reject('medication', 'duplicate', item.evidenceQuote);
      continue;
    }
    medicationKeys.add(key);
    const days =
      item.duration && Number.isFinite(item.duration.amount) && item.duration.amount > 0
        ? durationInDays(item.duration.amount, item.duration.unit)
        : undefined;
    medications.push({
      text,
      evidenceQuote: verbatim(span),
      ...(days ? { durationDays: days } : {}),
    });
  }

  // Discharge
  let dischargeEvidenceQuote: string | undefined;
  if (raw.discharge) {
    const span = index.locate(raw.discharge.evidenceQuote);
    if (span === undefined) {
      reject('discharge', 'quote_not_found', raw.discharge.evidenceQuote);
    } else {
      const [from, to] = clauseBoundsAround(noteText, span.normalizedStart, span.normalizedEnd);
      const found = findDischarge(noteText.slice(from, to));
      const overlaps =
        found !== undefined &&
        from + found.start < span.normalizedEnd &&
        from + found.end > span.normalizedStart;
      if (overlaps) dischargeEvidenceQuote = verbatim(span);
      else reject('discharge', 'quote_unrelated', raw.discharge.evidenceQuote);
    }
  }

  // Plan items: quote checks and timing first, then untimed items inherit
  // the earliest follow-up visit, then dedupe.
  interface Candidate {
    readonly item: ModelExtraction['planItems'][number];
    readonly quote: string;
    readonly cap: number;
    dueAt?: Date;
  }
  const noteIntervals = forwardIntervals(noteText);
  const noteDates = new Set(writtenDates(noteText));
  const candidates: Candidate[] = [];
  for (const item of raw.planItems) {
    const span = index.locate(item.evidenceQuote);
    if (span === undefined) {
      reject('planItem', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const quote = quoteText(span);
    if (alnumCount(quote) < MIN_PLAN_QUOTE_ALNUM) {
      reject('planItem', 'quote_too_short', item.evidenceQuote);
      continue;
    }
    if (!hasKindKeyword(item.kind, quote) && !hasTimeExpression(quote)) {
      reject('planItem', 'quote_unrelated', item.evidenceQuote);
      continue;
    }
    if (isConditional(segmentAround(noteText, span.normalizedStart, span.normalizedEnd))) {
      reject('planItem', 'conditional', item.evidenceQuote);
      continue;
    }
    const resolution = resolveDueAt(note.authoredAt, item.timing);
    if (!resolution.ok) {
      if (resolution.reason === 'due_before_note') {
        reject('planItem', 'due_before_note', item.evidenceQuote);
      } else {
        candidates.push({ item, quote: verbatim(span), cap: INHERITED_TIMING_CONFIDENCE });
      }
      continue;
    }
    const days = daysBetween(note.authoredAt, resolution.dueAt);
    const agrees = (expected: number): boolean =>
      Math.abs(days - expected) <= Math.max(2, expected * TIMING_TOLERANCE);
    const clause = clauseAround(noteText, span.normalizedStart, span.normalizedEnd);
    if (hasTimeExpression(clause)) {
      const stated = forwardIntervals(clause).map(approxDays);
      if (item.timing?.date === null && stated.length > 0 && !stated.some(agrees)) {
        reject('planItem', 'timing_mismatch', item.evidenceQuote);
        continue;
      }
      candidates.push({
        item,
        quote: verbatim(span),
        cap: MAX_ITEM_CONFIDENCE,
        dueAt: resolution.dueAt,
      });
      continue;
    }
    // Timing not stated where the item is quoted: keep the model's only if
    // the note states that interval or date somewhere else.
    const explicit = item.timing?.date ? parseIsoDate(item.timing.date) : undefined;
    const statedElsewhere = explicit
      ? noteDates.has(utcDay(explicit))
      : noteIntervals.map(approxDays).some(agrees);
    candidates.push(
      statedElsewhere
        ? { item, quote: verbatim(span), cap: DETACHED_TIMING_CONFIDENCE, dueAt: resolution.dueAt }
        : { item, quote: verbatim(span), cap: INHERITED_TIMING_CONFIDENCE },
    );
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
      confidence: Math.min(candidate.cap, clampConfidence(item.confidence)),
      ...(loinc ? { code: { system: LOINC_SYSTEM, code: loinc } } : {}),
    });
  }

  const discharged = dischargeEvidenceQuote !== undefined;
  return {
    hasPlan: raw.hasPlan || planItems.length > 0 || discharged,
    conditions: [...conditionsByCode.values()],
    medications,
    planItems,
    discharged,
    ...(dischargeEvidenceQuote === undefined ? {} : { dischargeEvidenceQuote }),
    rejected,
    modelItemCount:
      raw.conditions.length +
      raw.medications.length +
      raw.planItems.length +
      (raw.discharge ? 1 : 0),
  };
}
