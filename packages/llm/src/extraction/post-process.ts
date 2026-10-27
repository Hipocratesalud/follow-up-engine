import {
  type Coding,
  ICD10_SYSTEM,
  orderCodingOf,
  type PlanItem,
  type PlanItemKind,
} from '@follow-up-engine/core';
import { conditionTermsFor, type ConditionTermTable } from './condition-terms.ts';
import { daysBetween, durationInDays, parseIsoDate, resolveDueAt } from './due-date.ts';
import { lexiconLanguage, type LexiconLanguage } from './language.ts';
import { namedTests, testGroup, testGroupOfLoinc, testGroupsIn } from './lab-tests.ts';
import { postProcessPregnancy } from './pregnancy.ts';
import { gestationalAges, statesCurrentPregnancy } from './pregnancy-signals.ts';
import { prepareNote, type PreparedNote } from './prepare.ts';
import { createQuoteIndex, normalizeForMatch, type QuoteSpan } from './quote.ts';
import type { ModelExtraction, ModelPlanItem } from './schema.ts';
import {
  clauseAround,
  clauseBoundsAround,
  conditionContext,
  findDischarge,
  findKindKeyword,
  hasKindKeyword,
  hasTimeExpression,
  isConditional,
  isHedgedMention,
  isNegatedMention,
  isVerifiable,
  looksLikeMeasurement,
  segmentAround,
  statedTiming,
  statesSuspension,
  termsPattern,
  type StatedTiming,
} from './signals.ts';
import type {
  ExtractedCondition,
  ExtractedMedication,
  ExtractedPregnancy,
  RejectedItem,
} from './types.ts';

export interface PostProcessed {
  readonly hasPlan: boolean;
  readonly conditions: readonly ExtractedCondition[];
  readonly medications: readonly ExtractedMedication[];
  readonly planItems: readonly PlanItem[];
  readonly pregnancy?: ExtractedPregnancy;
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
  /**
   * Terms that can back each ICD-10 category, for every language. Defaults to
   * the table of the note's language (`conditionTermsFor`).
   */
  readonly conditionTerms?: ConditionTermTable;
  /**
   * BCP-47 language of the note (`en`, `es-VE`): picks the lexicons of every
   * check (negation, discharge, conditional returns, timing, plan wording).
   * Absent: Spanish, the engine's original lexicons.
   */
  readonly language?: string;
}

const MS_PER_DAY = 86_400_000;
/** A due date this close to a written month ("en abril") still counts as that month. */
const MONTH_EDGE_DAYS = 3;

const GENERIC_DESCRIPTIONS: Readonly<Record<PlanItemKind, string>> = {
  follow_up_visit: 'follow-up visit',
  lab: 'laboratory tests',
  imaging: 'imaging study',
  session: 'therapy sessions',
  other: 'other follow-up',
};

/** What the engine keeps of a plan item once its quote has been read. */
interface PlanReading {
  readonly kind: PlanItemKind;
  readonly description: string;
  /** LOINC, or the lexicon's own code of a procedure (`fundus-exam`). */
  readonly code?: Coding;
  /** What makes two items of the same kind and day the same item. */
  readonly key: string;
  /** The quote does not name what the model said (a lab quoted as "Control en 3 meses"). */
  readonly downgraded: boolean;
}

const TARGET_WEEKS = /(?<![a-z0-9])a (?:los|las) (\d{1,2}) ?(?:semanas|semana|sem)(?![a-z])/;

/**
 * When a study is due at a gestational age ("eco morfologico a las 20
 * semanas") and the note states the current one ("embarazo de 12 sem"):
 * the note date plus the difference. Undefined when the note states no
 * current pregnancy, its ages disagree, or the target is not ahead.
 */
function gestationalTargetDue(
  clause: string,
  noteText: string,
  authoredAt: Date,
  lang: LexiconLanguage,
): Date | undefined {
  // The gestational readers are Spanish ("a las 20 semanas", "embarazo de 12 sem").
  if (lang !== 'es') return undefined;
  const target = TARGET_WEEKS.exec(clause);
  if (target?.[1] === undefined || !statesCurrentPregnancy(noteText)) return undefined;
  const ages = gestationalAges(noteText);
  const [first] = ages;
  if (first === undefined || ages.some((age) => age.weeks !== first.weeks)) return undefined;
  const days = Number(target[1]) * 7 - (first.weeks * 7 + (first.days ?? 0));
  return days > 0 ? new Date(authoredAt.getTime() + days * MS_PER_DAY) : undefined;
}

/** "sesión" / "session": the next session of a series. */
const SESSION_WORD = /(?<![a-z])(?:sesion(?:es)?|sessions?)(?![a-z])/;

/**
 * Whether `quote` (normalized) names the kind of plan item it supports: the
 * plan wording of `signals.ts`, or for a lab or imaging item any test of the
 * lexicon (`lab-tests.ts`), so a test the model quotes by a name the plan
 * wording lacks ("curva de tolerancia glucosada") is read as a test.
 */
function namesKind(kind: ModelPlanItem['kind'], quote: string, lang: LexiconLanguage): boolean {
  if (hasKindKeyword(kind, quote, lang)) return true;
  return (kind === 'lab' || kind === 'imaging') && testGroupsIn(quote, kind).size > 0;
}

/**
 * Whether a plan quote too short to back an item on its own is exactly one
 * test, referral or procedure name: the model quotes a list item by its
 * bare abbreviation ("K+", "HIV", "ECG" in "Se solicita: creatinina, K+,
 * ECG"). Its timing is still read from the sentence around it.
 */
function isWholeTerm(kind: ModelPlanItem['kind'], quote: string, lang: LexiconLanguage): boolean {
  const term = quote.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+]+$/gu, '');
  if (alnumCount(term) === 0) return false;
  if (kind === 'lab' || kind === 'imaging') {
    return namedTests(term).some(
      (test) => test.group.kind === kind && test.start === 0 && test.end === term.length,
    );
  }
  const match = findKindKeyword(kind, term, lang);
  return match !== null && match.index === 0 && match[0].length === term.length;
}

/**
 * Reads what a plan item is from its quote, not from the model's word:
 *
 * - a lab or imaging item whose quote has no lab or imaging wording at all
 *   ("HIV test" quoted as "Control en 3 meses"), or an `other` item whose
 *   quote names no referral or procedure, becomes a generic follow-up visit;
 * - a lab or imaging item keeps the model's description only when it names
 *   tests the quote names (`lab-tests.ts`); otherwise the description is
 *   the label of the tests the quote names, or a generic one;
 * - a LOINC code is kept only on lab items, only when well formed and only
 *   when its test is one the quote names.
 */
function readPlanItem(
  item: ModelPlanItem,
  quote: string,
  lang: LexiconLanguage,
): readonly [PlanReading, ...PlanReading[]] {
  const description = item.description.trim();
  const visit: PlanReading = {
    kind: 'follow_up_visit',
    description: GENERIC_DESCRIPTIONS.follow_up_visit,
    key: '',
    downgraded: true,
  };
  if (item.kind === 'lab' || item.kind === 'imaging') {
    const procedure = namedProcedure(quote, description, item.kind);
    if (procedure !== undefined) return [procedure];
    if (!namesKind(item.kind, quote, lang)) return [visit];
    const named = testGroupsIn(quote, item.kind);
    const described = testGroupsIn(normalizeForMatch(description), item.kind);
    if (named.size === 0) {
      return [
        {
          kind: item.kind,
          description: GENERIC_DESCRIPTIONS[item.kind],
          key: '',
          downgraded: false,
        },
      ];
    }
    const both = [...described].filter((id) => named.has(id));
    const resolved = both.length > 0 ? both : [...named];
    const keepsDescription = described.size > 0 && both.length === described.size;
    const loinc = item.kind === 'lab' ? normalizeLoinc(item.loincCode) : undefined;
    const loincGroup = loinc === undefined ? undefined : testGroupOfLoinc(loinc);
    if (resolved.length === 1 || item.kind === 'imaging') {
      const single = resolved.length === 1 ? testGroup(resolved[0] ?? '') : undefined;
      const code =
        loinc !== undefined && loincGroup !== undefined && resolved.includes(loincGroup.id)
          ? { system: LOINC_SYSTEM, code: loinc }
          : single === undefined
            ? undefined
            : orderCodingOf(single);
      return [
        {
          kind: item.kind,
          description: keepsDescription
            ? description
            : resolved.map((id) => testGroup(id)?.label ?? id).join(' and '),
          ...(code === undefined ? {} : { code: { system: code.system, code: code.code } }),
          key: [...resolved].sort().join('+'),
          downgraded: false,
        },
      ];
    }
    // One lab item for several tests ("pendiente HbA1c, creatinina y
    // microalbuminuria"): one item per test, each with its code, so each
    // waits for its own result.
    const groups = resolved.flatMap((id) => {
      const group = testGroup(id);
      return group === undefined ? [] : [group];
    });
    const [first, ...rest] = groups.map((group): PlanReading => {
      const code =
        loinc !== undefined && loincGroup?.id === group.id
          ? { system: LOINC_SYSTEM, code: loinc }
          : orderCodingOf(group);
      return {
        kind: item.kind,
        description: group.label,
        ...(code === undefined ? {} : { code: { system: code.system, code: code.code } }),
        key: group.id,
        downgraded: false,
      };
    });
    return first === undefined ? [visit] : [first, ...rest];
  }
  if (item.kind === 'other') {
    // "Fondo de ojo" is the eye fundus exam (a coded procedure), whatever
    // the model called it: a test, never fulfilled by an unrelated visit.
    const procedure = namedProcedure(quote, description, item.kind);
    if (procedure !== undefined) return [procedure];
    if (findKindKeyword('other', quote, lang) === null) return [visit];
  }
  if (item.kind === 'follow_up_visit') {
    // "Próx. sesión en 1 semana": the next session of a series, whatever the model called it.
    const kind = SESSION_WORD.test(quote) ? 'session' : item.kind;
    return [
      {
        kind,
        description: description || GENERIC_DESCRIPTIONS.follow_up_visit,
        key: '',
        downgraded: false,
      },
    ];
  }
  return [
    {
      kind: item.kind,
      description: description || GENERIC_DESCRIPTIONS[item.kind],
      key: normalizeForMatch(description),
      downgraded: false,
    },
  ];
}

/**
 * The coded procedure (a test with its own code, not a LOINC: the eye
 * fundus exam) a plan item is about: the one its description names, else
 * the only one its quote names. `undefined` when there is none.
 */
function namedProcedure(
  quote: string,
  description: string,
  kind: ModelPlanItem['kind'],
): PlanReading | undefined {
  const procedures = (text: string) =>
    [...testGroupsIn(text)].flatMap((id) => {
      const group = testGroup(id);
      return group?.code === undefined ? [] : [group];
    });
  const inQuote = procedures(quote);
  const described = procedures(normalizeForMatch(description)).filter((group) =>
    inQuote.includes(group),
  );
  const candidates = described.length > 0 ? described : inQuote;
  const group = candidates.length === 1 ? candidates[0] : undefined;
  // A lab item whose quote also names a procedure ("HbA1c y fondo de ojo")
  // stays the lab tests, unless its description is the procedure.
  if (group === undefined || (kind === 'lab' && described.length === 0 && namesLab(quote))) {
    return undefined;
  }
  const code = orderCodingOf(group);
  return {
    kind: group.kind,
    description: group.label,
    ...(code === undefined ? {} : { code: { system: code.system, code: code.code } }),
    key: group.id,
    downgraded: false,
  };
}

function namesLab(quote: string): boolean {
  return testGroupsIn(quote, 'lab').size > 0;
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
 * - denied conditions ("niega HTA", "Diabetes: no") are dropped, and so are
 *   a relative's ("madre con DM2", "AHF: HTA (padre)") and non-current ones
 *   ("riesgo de diabetes", gestational diabetes or a past pregnancy);
 *   suspected ones get a confidence below every engine threshold;
 *   measurements are never medications; conditional returns ("volver si
 *   fiebre", "volver en 1 mes si no mejora", "si no mejora en 1 semana,
 *   reconsultar") are not plan, nor is a cancelled one ("se suspende el
 *   control en 1 mes");
 * - a lab or imaging item is what its quote names (`readPlanItem`): its
 *   description and LOINC code survive only when the quote names that test,
 *   and a lab quoted as "Control en 3 meses" becomes a generic follow-up;
 * - plan due dates are computed here from `authoredAt`, never by the model,
 *   and only from timing the note states where the item is quoted (or, with
 *   a lower confidence, elsewhere in the note); an interval that contradicts
 *   the quoted one is rejected (`timing_mismatch`), and so is an explicit
 *   date that is neither written there nor follows from the interval written
 *   there (`timing_unsupported`); an untimed lab or imaging item, or one due
 *   "antes de la proxima consulta", inherits the earliest follow-up visit;
 * - confidences are the model's, clamped to {@link MAX_ITEM_CONFIDENCE} and
 *   capped by those checks;
 * - a discharge needs a quote that states one ("se da de alta");
 * - the pregnancy reading (dating, outcome) is checked by
 *   `postProcessPregnancy`: current pregnancy only, values written in the
 *   note and in range, an outcome that is not obstetric history;
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
  const lang = lexiconLanguage(options.language);
  const terms = options.conditionTerms ?? conditionTermsFor(lang);
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

  // Conditions. A short quote ("HTA") can occur more than once: the first
  // occurrence that is about this patient backs the item ("Antecedente: madre
  // con HTA. Dx: HTA estadio 2").
  const conditionsByCode = new Map<string, ExtractedCondition>();
  for (const item of raw.conditions) {
    const spans = index.locateAll(item.evidenceQuote);
    const first = spans[0];
    if (first === undefined) {
      reject('condition', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    if (alnumCount(quoteText(first)) < MIN_QUOTE_ALNUM) {
      reject('condition', 'quote_too_short', item.evidenceQuote);
      continue;
    }
    const code = normalizeIcd10(item.icd10);
    if (code === undefined) {
      reject('condition', 'invalid_code', item.evidenceQuote);
      continue;
    }
    const pattern = conditionPattern(terms, code.slice(0, 3));
    let backing: { span: QuoteSpan; termStart: number; termEnd: number } | undefined;
    let firstReason: RejectedItem['reason'] | undefined;
    for (const span of spans) {
      const term = firstMatch(pattern, quoteText(span));
      if (!term) {
        firstReason ??= 'quote_unrelated';
        continue;
      }
      const termStart = span.normalizedStart + term.index;
      const termEnd = termStart + term[0].length;
      const reason = isNegatedMention(noteText, termStart, termEnd, lang)
        ? 'negated'
        : conditionContext(noteText, termStart, termEnd, code.slice(0, 3), lang);
      if (reason === undefined) {
        backing = { span, termStart, termEnd };
        break;
      }
      firstReason ??= reason;
    }
    if (backing === undefined) {
      reject('condition', firstReason ?? 'quote_unrelated', item.evidenceQuote);
      continue;
    }
    const cap = isHedgedMention(noteText, backing.termStart, backing.termEnd, lang)
      ? HEDGED_CONDITION_CONFIDENCE
      : MAX_ITEM_CONFIDENCE;
    const display = item.display.trim();
    const condition: ExtractedCondition = {
      code: { system: ICD10_SYSTEM, code, ...(display ? { display } : {}) },
      confidence: Math.min(cap, clampConfidence(item.confidence)),
      evidenceQuote: verbatim(backing.span),
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
    if (looksLikeMeasurement(key, lang) || looksLikeMeasurement(quote, lang)) {
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
      const [from, to] = clauseBoundsAround(
        noteText,
        span.normalizedStart,
        span.normalizedEnd,
        lang,
      );
      const found = findDischarge(noteText.slice(from, to), lang);
      const overlaps =
        found !== undefined &&
        from + found.start < span.normalizedEnd &&
        from + found.end > span.normalizedStart;
      if (overlaps) dischargeEvidenceQuote = verbatim(span);
      else reject('discharge', 'quote_unrelated', raw.discharge.evidenceQuote);
    }
  }

  // Plan items: quote checks, what the quote says the item is, and timing
  // first; then untimed items inherit the earliest follow-up visit; then dedupe.
  interface Candidate {
    readonly item: ModelPlanItem;
    /** Usually one; one per test when a lab item named several. */
    readonly readings: readonly PlanReading[];
    readonly quote: string;
    readonly cap: number;
    dueAt?: Date;
  }
  const noteDay = utcDay(note.authoredAt);
  const noteTiming = statedTiming(noteText, noteDay, lang);
  const supports = (timing: StatedTiming, dueAt: Date, fromDate: boolean): boolean => {
    const days = daysBetween(note.authoredAt, dueAt);
    const near = (expected: number): boolean =>
      Math.abs(days - expected) <= Math.max(2, expected * TIMING_TOLERANCE);
    if (timing.days.some(near)) return true;
    for (const written of timing.dates) {
      const date = parseIsoDate(written);
      if (date === undefined) continue;
      const expected = daysBetween(note.authoredAt, date);
      if (fromDate ? Math.abs(days - expected) <= 1 : near(expected)) return true;
    }
    const dueMonth = utcDay(dueAt).slice(0, 7);
    const nearMonth = [-MONTH_EDGE_DAYS, MONTH_EDGE_DAYS].map((shift) =>
      utcDay(new Date(dueAt.getTime() + shift * MS_PER_DAY)).slice(0, 7),
    );
    return timing.months.some((month) => month === dueMonth || nearMonth.includes(month));
  };
  const candidates: Candidate[] = [];
  for (const item of raw.planItems) {
    const span = index.locate(item.evidenceQuote);
    if (span === undefined) {
      reject('planItem', 'quote_not_found', item.evidenceQuote);
      continue;
    }
    const quote = quoteText(span);
    if (alnumCount(quote) < MIN_PLAN_QUOTE_ALNUM && !isWholeTerm(item.kind, quote, lang)) {
      reject('planItem', 'quote_too_short', item.evidenceQuote);
      continue;
    }
    if (!namesKind(item.kind, quote, lang) && !hasTimeExpression(quote, lang)) {
      reject('planItem', 'quote_unrelated', item.evidenceQuote);
      continue;
    }
    const clause = clauseAround(noteText, span.normalizedStart, span.normalizedEnd, lang);
    if (
      isConditional(
        segmentAround(noteText, span.normalizedStart, span.normalizedEnd, lang),
        clause,
        lang,
      )
    ) {
      reject('planItem', 'conditional', item.evidenceQuote);
      continue;
    }
    // The list item the quote ends in: "se suspende metformina, control en 3 meses" keeps the control.
    if (
      statesSuspension(
        segmentAround(noteText, span.normalizedEnd - 1, span.normalizedEnd, lang),
        lang,
      )
    ) {
      reject('planItem', 'cancelled', item.evidenceQuote);
      continue;
    }
    const readings = readPlanItem(item, quote, lang);
    const [reading] = readings;
    const targetDue = gestationalTargetDue(clause, noteText, note.authoredAt, lang);
    if (targetDue !== undefined) {
      // "Eco morfológico a las 20 semanas" in a note at week 12: due in 8 weeks, computed here.
      candidates.push({
        item,
        readings,
        quote: verbatim(span),
        cap: MAX_ITEM_CONFIDENCE,
        dueAt: targetDue,
      });
      continue;
    }
    const resolution = resolveDueAt(note.authoredAt, item.timing);
    if (!resolution.ok) {
      if (resolution.reason === 'due_before_note') {
        reject('planItem', 'due_before_note', item.evidenceQuote);
      } else {
        candidates.push({
          item,
          readings,
          quote: verbatim(span),
          cap: INHERITED_TIMING_CONFIDENCE,
        });
      }
      continue;
    }
    const fromDate = item.timing?.date ? parseIsoDate(item.timing.date) !== undefined : false;
    const timed = (cap: number): Candidate => ({
      item,
      readings,
      quote: verbatim(span),
      cap,
      dueAt: resolution.dueAt,
    });
    const untimed: Candidate = {
      item,
      readings,
      quote: verbatim(span),
      cap: INHERITED_TIMING_CONFIDENCE,
    };
    // The timing written where the item is quoted decides; an explicit date
    // must be written there too (or follow from the interval written there).
    const clauseTiming = statedTiming(clause, noteDay, lang);
    if (isVerifiable(clauseTiming)) {
      if (supports(clauseTiming, resolution.dueAt, fromDate)) {
        candidates.push(timed(MAX_ITEM_CONFIDENCE));
      } else {
        reject('planItem', fromDate ? 'timing_unsupported' : 'timing_mismatch', item.evidenceQuote);
      }
      continue;
    }
    const inherits = reading.kind === 'lab' || reading.kind === 'imaging';
    if (clauseTiming.nextVisit && inherits) {
      // "antes de la proxima consulta": due with the next visit, whatever the model computed.
      candidates.push(untimed);
    } else if (clauseTiming.targetAge && !fromDate) {
      // "a las 20 semanas": a target age the code cannot check.
      candidates.push(timed(MAX_ITEM_CONFIDENCE));
    } else if (supports(noteTiming, resolution.dueAt, fromDate)) {
      // Stated elsewhere in the note, not where the item is quoted.
      candidates.push(timed(DETACHED_TIMING_CONFIDENCE));
    } else if (fromDate) {
      reject('planItem', 'timing_unsupported', item.evidenceQuote);
    } else {
      candidates.push(untimed);
    }
  }
  const nextVisit = candidates
    .flatMap((c) => (c.readings[0]?.kind === 'follow_up_visit' && c.dueAt ? [c.dueAt] : []))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const planItems: PlanItem[] = [];
  const planKeys = new Set<string>();
  for (const candidate of candidates) {
    const { item, readings } = candidate;
    const [first] = readings;
    if (first === undefined) continue;
    const inherits = first.kind === 'lab' || first.kind === 'imaging';
    const dueAt = candidate.dueAt ?? (inherits ? nextVisit : undefined);
    if (!dueAt) {
      reject('planItem', 'no_due_date', item.evidenceQuote);
      continue;
    }
    if (first.downgraded) reject('planItem', 'test_not_named', item.evidenceQuote);
    for (const reading of readings) {
      const key = `${reading.kind}|${utcDay(dueAt)}|${reading.key}`;
      if (planKeys.has(key)) {
        reject('planItem', 'duplicate', item.evidenceQuote);
        continue;
      }
      planKeys.add(key);
      planItems.push({
        kind: reading.kind,
        description: reading.description,
        dueAt,
        evidenceQuote: candidate.quote,
        confidence: Math.min(candidate.cap, clampConfidence(item.confidence)),
        ...(reading.code ? { code: reading.code } : {}),
      });
    }
  }

  const pregnancy = postProcessPregnancy(raw.pregnancy, {
    index,
    authoredAt: note.authoredAt,
    verbatim,
  });
  rejected.push(...pregnancy.rejected);

  const discharged = dischargeEvidenceQuote !== undefined;
  return {
    hasPlan: raw.hasPlan || planItems.length > 0 || discharged,
    conditions: [...conditionsByCode.values()],
    medications,
    planItems,
    ...(pregnancy.pregnancy === undefined ? {} : { pregnancy: pregnancy.pregnancy }),
    discharged,
    ...(dischargeEvidenceQuote === undefined ? {} : { dischargeEvidenceQuote }),
    rejected,
    modelItemCount:
      raw.conditions.length +
      raw.medications.length +
      raw.planItems.length +
      (raw.discharge ? 1 : 0) +
      pregnancy.modelItemCount,
  };
}
