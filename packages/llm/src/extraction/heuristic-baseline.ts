import type { PlanItemKind } from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import { namedTests } from './lab-tests.ts';
import {
  agoDays,
  estimatedDeliveryDates,
  gestationalAges,
  isDatingDate,
  lastMenstrualPeriods,
  outcomeMentions,
  resolveWrittenDay,
  statesCurrentPregnancy,
  writtenDays,
  type OutcomeMention,
} from './pregnancy-signals.ts';
import { readNoteDateFromMessages, readNoteFromMessages } from './prompt.ts';
import { createQuoteIndex } from './quote.ts';
import type {
  ModelCondition,
  ModelExtraction,
  ModelMedication,
  ModelPlanItem,
  ModelPregnancy,
  ModelPregnancyOutcome,
  TimeUnit,
} from './schema.ts';
import {
  NUMBER_WORDS,
  UNIT_WORDS,
  clauseBoundsAround,
  conditionContext,
  findDischarge,
  isConditional,
  isNegatedMention,
  looksLikeMeasurement,
  parseAmount,
  segmentAround,
  statedTiming,
  statesSuspension,
} from './signals.ts';

/**
 * A rule-based extractor that answers like a model would. It is what the
 * fake provider returns when no fixture matches, which gives the eval
 * harness an honest, offline baseline: the number a Meta model has to beat.
 * Regexes over normalized text (lowercase, no accents); quotes are taken
 * from the original note so they pass the verbatim check. It shares the
 * post-checks' reading of negation ("niega HTA", "Diabetes: no"), family
 * history ("madre con DM2"), risk and past pregnancy, conditional returns
 * ("volver si fiebre", "volver en 1 mes si no mejora"), measurements
 * ("Hemoglobina 10,8 g/dL"), discharge ("se da de alta", "se cierra el
 * proceso terapeutico", not "dado de alta del hospital") and named tests
 * (one lab item per test, "perfil lipidico y microalbuminuria antes de la
 * proxima consulta" due with the next control). Each plan item keeps its
 * own interval ("TSH en 6 semanas, control en 3 meses"), frequency words are
 * intervals ("control anual") and cancelled follow-ups are skipped ("se
 * suspende el control en 1 mes"). It dates a current pregnancy ("embarazo de
 * 20 semanas y 3 dias", "G2P1, 20 sem", "EG: 20+3", "FUM 03/04/2026", "FPP
 * 10/01/2027") and reads its outcome ("parto vaginal el 02/03/2026",
 * "cesarea segmentaria hace 10 dias", "puerpera de 10 dias, parto
 * eutocico", "aborto espontaneo"), never obstetric history ("G3P2,
 * cesarea previa") nor a routine "FUM" in an annual control.
 */

interface ConditionPattern {
  readonly pattern: RegExp;
  readonly icd10: string;
  readonly display: string;
}

const CONDITION_PATTERNS: readonly ConditionPattern[] = [
  {
    pattern: /\b(prediabetes|pre-diabetes|pre diabetes|prediabetic[oa])\b/,
    icd10: 'R73.03',
    display: 'prediabetes',
  },
  {
    pattern: /\b(diabetes gestacional|dmg)\b/,
    icd10: 'O24',
    display: 'gestational diabetes',
  },
  {
    pattern: /\b(dm ?2|dm tipo 2|diabetes mellitus tipo 2|diabetes tipo 2|diabetes)\b/,
    icd10: 'E11',
    display: 'type 2 diabetes mellitus',
  },
  {
    pattern: /\b(hta|hipertension arterial|hipertension)\b/,
    icd10: 'I10',
    display: 'essential hypertension',
  },
  { pattern: /\b(hipotiroidismo)\b/, icd10: 'E03', display: 'hypothyroidism' },
  {
    pattern: /\b(dislipidemia|hipercolesterolemia|hipertrigliceridemia)\b/,
    icd10: 'E78',
    display: 'dyslipidemia',
  },
  { pattern: /\b(asma)\b/, icd10: 'J45', display: 'asthma' },
  { pattern: /\b(epoc)\b/, icd10: 'J44', display: 'COPD' },
  {
    pattern: /\b(erc|enfermedad renal cronica)\b/,
    icd10: 'N18',
    display: 'chronic kidney disease',
  },
  { pattern: /\b(fibrilacion auricular|fa)\b/, icd10: 'I48', display: 'atrial fibrillation' },
  { pattern: /\b(insuficiencia cardiaca|icc)\b/, icd10: 'I50', display: 'heart failure' },
  { pattern: /\b(depresion|episodio depresivo)\b/, icd10: 'F32', display: 'depressive episode' },
  {
    pattern: /\b(trastorno de ansiedad|ansiedad generalizada)\b/,
    icd10: 'F41',
    display: 'anxiety disorder',
  },
  { pattern: /\b(obesidad)\b/, icd10: 'E66', display: 'obesity' },
  { pattern: /\b(lumbalgia|lumbago)\b/, icd10: 'M54', display: 'low back pain' },
  {
    pattern: /\b(gonartrosis|artrosis de rodilla)\b/,
    icd10: 'M17',
    display: 'knee osteoarthritis',
  },
  {
    pattern: /\b(hpb|hiperplasia prostatica)\b/,
    icd10: 'N40',
    display: 'benign prostatic hyperplasia',
  },
  {
    pattern: /\b(anemia ferropenica|ferropenia)\b/,
    icd10: 'D50',
    display: 'iron deficiency anemia',
  },
  { pattern: /\b(anemia)\b(?! ferropenica)/, icd10: 'D64', display: 'anemia' },
  {
    pattern: /\b(itu|infeccion urinaria|infeccion de vias urinarias)\b/,
    icd10: 'N39',
    display: 'urinary tract infection',
  },
  { pattern: /\b(migrana)\b/, icd10: 'G43', display: 'migraine' },
  { pattern: /\b(erge|reflujo gastroesofagico)\b/, icd10: 'K21', display: 'GERD' },
  { pattern: /\b(osteoporosis)\b/, icd10: 'M81', display: 'osteoporosis' },
  {
    pattern: /\b(embarazo|gestacion)\b(?! (?:ectopico|molar|anembrionado))/,
    icd10: 'Z34',
    display: 'pregnancy supervision',
  },
  { pattern: /\b(puerperio|puerpera)\b/, icd10: 'Z39', display: 'postpartum care' },
  {
    pattern:
      /(?<!amenaza de )\b(aborto espontaneo|aborto incompleto|aborto completo|aborto|perdida gestacional)\b/,
    icd10: 'O03',
    display: 'spontaneous abortion',
  },
];

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNIT = String.raw`(dias|dia|semanas|semana|sem|meses|mes|anos|ano)`;
const RELATIVE_TIMING = new RegExp(String.raw`\b(?:en|cada) ${AMOUNT} ${UNIT}\b`, 'g');
const NEXT_TIMING = /\b(proximo mes|proxima semana|proximo ano|mes que viene)\b/g;
/** "control anual", "control semestral": the interval is the frequency word. */
const PERIODIC_TIMING =
  /\b(semanal|semanalmente|quincenal|mensual|mensualmente|bimestral|trimestral|semestral|anual|anualmente)\b/g;
const PERIODIC_INTERVALS: Readonly<Record<string, { amount: number; unit: TimeUnit }>> = {
  semanal: { amount: 1, unit: 'week' },
  semanalmente: { amount: 1, unit: 'week' },
  quincenal: { amount: 15, unit: 'day' },
  mensual: { amount: 1, unit: 'month' },
  mensualmente: { amount: 1, unit: 'month' },
  bimestral: { amount: 2, unit: 'month' },
  trimestral: { amount: 3, unit: 'month' },
  semestral: { amount: 6, unit: 'month' },
  anual: { amount: 1, unit: 'year' },
  anualmente: { amount: 1, unit: 'year' },
};

const KIND_PATTERNS: readonly (readonly [PlanItemKind, RegExp])[] = [
  [
    'lab',
    /\b(hba1c|laboratorio|laboratorios|labs?|examenes|perfil lipidico|hemograma|tsh|t4|creatinina|potasio|glicemia|glucemia|examen de orina|uroanalisis|urocultivo|psa|ferritina|microalbuminuria|citologia)\b/,
  ],
  [
    'imaging',
    /\b(eco|ecografia|ecocardiograma|rx|radiografia|tac|tomografia|rm|resonancia|mamografia|densitometria|doppler)\b/,
  ],
  [
    'session',
    /\b(sesion|sesiones|fisioterapia|kinesiologia|psicoterapia|terapia|rehabilitacion|proceso)\b/,
  ],
  [
    'follow_up_visit',
    /\b(control|ctrl|cita|consulta|reevaluar|reevaluacion|revision|seguimiento|volver)\b/,
  ],
  ['other', /\b(referir|referencia|interconsulta|derivar)\b/],
];

const DESCRIPTIONS: Readonly<Record<PlanItemKind, string>> = {
  follow_up_visit: 'follow-up visit',
  lab: 'laboratory test',
  imaging: 'imaging study',
  session: 'therapy sessions',
  other: 'other follow-up',
};

const MEDICATION =
  /\b([a-z]{4,}) (\d+(?:[.,]\d+)?) ?(mg|mcg|ug|g|ui|ml|puff)\b(?!\s*\/\s*(?:dl|l|ul|mm3))(?:.*?)(?= y |[;,\n]|\.(?!\d)|$)/g;
const DURATION = new RegExp(String.raw`\bpor ${AMOUNT} ${UNIT}\b`);
const NOT_DRUGS = new Set([
  'dosis',
  'glicemia',
  'glucemia',
  'glucosa',
  'colesterol',
  'trigliceridos',
  'hemoglobina',
  'hematocrito',
  'creatinina',
  'ferritina',
  'ayunas',
  'previa',
  'actual',
  'peso',
]);
const ABSOLUTE_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const NAMED_DATE =
  /\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g;
/** "antes de la proxima consulta", "al proximo control": due with the next visit. */
const WITH_NEXT_VISIT =
  /\b(?:antes de|para|a|al|en) (?:la |el )?prox(?:im[oa])?\.? (?:control|ctrl|cita|consulta|visita)\b/g;
/** Where one item of a plan list ends: a comma (not a decimal one), "y", "pero", "aunque". */
const SEGMENT_BREAK = /(?<!\d),|,(?!\d)|\b(?:y|pero|aunque)\b/g;
/** A dose ("50000 UI", "500 mg"): a frequency word next to it is a dosing schedule. */
const DOSE = /\d ?(?:mg|mcg|ug|g|ui|ml|gotas|puff|tabletas?|comprimidos?|capsulas?)\b/;
/**
 * The visit being described, not the next one: "acude a control
 * ginecologico anual", "sesion de seguimiento mensual".
 */
const VISIT_DESCRIPTION =
  /\b(?:acude|acudio|asiste|asistio|viene|vino|consulta por|motivo)\b|\b(?:sesion|consulta|cita|control) de\b|\bde (?:control|seguimiento|sesion)\b/;

/** Whether a frequency word in this list item is a dosing schedule or describes today's visit. */
function notAPlanFrequency(segment: string): boolean {
  return DOSE.test(segment) || VISIT_DESCRIPTION.test(segment);
}
/** Fewest letters and digits a plan quote needs (the post-checks reject shorter ones). */
const MIN_QUOTE_ALNUM = 4;

function sentences(normalized: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const pattern = /[^.;\n]+/g;
  for (let match = pattern.exec(normalized); match; match = pattern.exec(normalized)) {
    out.push({ text: match[0], start: match.index });
  }
  return out;
}

/**
 * Runs the rule-based extraction on a note. `noteDay` (`YYYY-MM-DD`) dates
 * a written day without a year ("el 15 de julio"). Linear in the note length.
 */
export function heuristicExtraction(note: string, noteDay?: string): ModelExtraction {
  const index = createQuoteIndex(note);
  const normalized = index.normalized.text;
  const quoteOf = (start: number, end: number): string => index.spanOf(start, end)?.text ?? '';

  const conditions: ModelCondition[] = [];
  for (const { pattern, icd10, display } of CONDITION_PATTERNS) {
    const global = new RegExp(pattern.source, 'g');
    for (const match of normalized.matchAll(global)) {
      const end = match.index + match[0].length;
      if (isNegatedMention(normalized, match.index, end)) continue;
      if (conditionContext(normalized, match.index, end, icd10.slice(0, 3)) !== undefined) continue;
      conditions.push({
        icd10,
        display,
        confidence: 0.6,
        evidenceQuote: quoteOf(match.index, end),
      });
      break;
    }
  }

  const medications: ModelMedication[] = [];
  for (const match of normalized.matchAll(MEDICATION)) {
    const drug = match[1] ?? '';
    if (NOT_DRUGS.has(drug) || looksLikeMeasurement(match[0])) continue;
    const quote = quoteOf(match.index, match.index + match[0].length).trim();
    const duration = DURATION.exec(match[0]);
    medications.push({
      text: quote,
      duration:
        duration?.[1] && duration[2]
          ? { amount: parseAmount(duration[1]), unit: UNIT_WORDS[duration[2]] ?? 'day' }
          : null,
      evidenceQuote: quote,
    });
  }

  const planItems: ModelPlanItem[] = [];
  for (const sentence of sentences(normalized)) {
    planItems.push(...sentencePlanItems(sentence, noteDay, quoteOf));
  }

  const pregnancy = noteDay === undefined ? null : readPregnancy(normalized, noteDay, quoteOf);
  const discharge = findDischarge(normalized);
  const hasPlan =
    planItems.length > 0 ||
    discharge !== undefined ||
    /\b(plan|indicaciones|ctrl|control)\b/.test(normalized);
  return {
    hasPlan,
    discharge: discharge ? { evidenceQuote: quoteOf(discharge.start, discharge.end) } : null,
    conditions,
    medications,
    planItems,
    pregnancy,
  };
}

const OUTCOME_PRIORITY: readonly ModelPregnancyOutcome['kind'][] = [
  'cesarean_delivery',
  'loss',
  'vaginal_delivery',
];

/**
 * The outcome of the pregnancy, from the first clause that names a delivery
 * or a loss that is not history, planned or denied ("cesarea segmentaria
 * hace 10 dias", "Puerpera de 10 dias, parto eutocico"): its kind (a
 * caesarean over a loss over a vaginal delivery), the quote from the first
 * to the last such words of the clause, its date when the clause writes one
 * and how long ago when it says so ("hace 10 dias", "puerpera de 10 dias").
 * A puerperium word alone says there was a delivery, not which: no outcome.
 */
function readOutcome(
  normalized: string,
  noteDay: string,
  quoteOf: (start: number, end: number) => string,
): ModelPregnancyOutcome | null {
  const accepted = outcomeMentions(normalized, Number(noteDay.slice(0, 4))).filter(
    (m) => m.excluded === undefined,
  );
  const byClause = new Map<number, { end: number; mentions: OutcomeMention[] }>();
  for (const mention of accepted) {
    const [start, end] = clauseBoundsAround(normalized, mention.start, mention.end);
    const clause = byClause.get(start) ?? { end, mentions: [] };
    clause.mentions.push(mention);
    byClause.set(start, clause);
  }
  for (const [clauseStart, { end: clauseEnd, mentions }] of byClause) {
    const kind = OUTCOME_PRIORITY.find((k) => mentions.some((m) => m.kind === k));
    if (kind === undefined) continue;
    const clause = normalized.slice(clauseStart, clauseEnd);
    const from = Math.min(...mentions.map((m) => m.start));
    const to = Math.max(...mentions.map((m) => m.end));
    const written = writtenDays(clause)[0];
    const date = written === undefined ? undefined : resolveWrittenDay(written, noteDay, 'past');
    const days = date === undefined ? agoDays(clause) : undefined;
    return {
      kind,
      date: date ?? null,
      daysAgo: days ?? null,
      evidenceQuote: quoteOf(from, to),
    };
  }
  return null;
}

/**
 * The pregnancy as the note writes it: its outcome (see `readOutcome`), or,
 * when the note states a current pregnancy, its first gestational age, last
 * menstrual period and estimated delivery date, quoted from the first of
 * them.
 */
function readPregnancy(
  normalized: string,
  noteDay: string,
  quoteOf: (start: number, end: number) => string,
): ModelPregnancy | null {
  const outcome = readOutcome(normalized, noteDay, quoteOf);
  const none = {
    gestationalWeeks: null,
    gestationalDays: null,
    lastMenstrualPeriod: null,
    estimatedDeliveryDate: null,
    datingEvidenceQuote: null,
  };
  if (outcome !== null) return { ...none, outcome };
  if (!statesCurrentPregnancy(normalized)) return null;
  const age = gestationalAges(normalized)[0];
  const lmp = lastMenstrualPeriods(normalized, noteDay)[0];
  const edd = estimatedDeliveryDates(normalized, noteDay)[0];
  const first = age ?? lmp ?? edd;
  if (first === undefined) return null;
  return {
    gestationalWeeks: age?.weeks ?? null,
    gestationalDays: age?.days ?? null,
    lastMenstrualPeriod: lmp?.date ?? null,
    estimatedDeliveryDate: edd?.date ?? null,
    datingEvidenceQuote: quoteOf(first.start, first.end),
    outcome: null,
  };
}

/** A timing phrase of a sentence, with what it means as model timing. */
interface TimingPhrase {
  readonly start: number;
  readonly end: number;
  readonly timing: ModelPlanItem['timing'];
  /** A frequency word ("control anual"): binds only to the words of its own list item. */
  readonly periodic: boolean;
}

function timingPhrases(text: string, noteDay: string | undefined): TimingPhrase[] {
  const found: TimingPhrase[] = [];
  const push = (match: RegExpExecArray, timing: ModelPlanItem['timing'], periodic = false) => {
    found.push({ start: match.index, end: match.index + match[0].length, timing, periodic });
  };
  for (const match of text.matchAll(RELATIVE_TIMING)) {
    const [, amount = '', unit = ''] = match;
    push(match, { amount: parseAmount(amount), unit: UNIT_WORDS[unit] ?? 'day', date: null });
  }
  for (const match of text.matchAll(NEXT_TIMING)) {
    const phrase = match[1] ?? '';
    const unit: TimeUnit = phrase.includes('semana')
      ? 'week'
      : phrase.includes('ano')
        ? 'year'
        : 'month';
    push(match, { amount: 1, unit, date: null });
  }
  for (const match of text.matchAll(ABSOLUTE_DATE)) {
    // "FUM 03/04/2026", "FPP 10/01/2027": the pregnancy's dates, not a follow-up's.
    if (isDatingDate(text, match.index)) continue;
    const [, d = '', m = '', y = ''] = match;
    push(match, {
      amount: null,
      unit: null,
      date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
    });
  }
  if (noteDay !== undefined) {
    for (const match of text.matchAll(NAMED_DATE)) {
      const date = statedTiming(match[0], noteDay).dates[0];
      push(match, date === undefined ? null : { amount: null, unit: null, date });
    }
  }
  for (const match of text.matchAll(WITH_NEXT_VISIT)) push(match, null);
  for (const match of text.matchAll(PERIODIC_TIMING)) {
    const interval = PERIODIC_INTERVALS[match[1] ?? ''];
    if (interval) push(match, { ...interval, date: null }, true);
  }
  // Earliest first; a phrase inside another one ("en 3 meses" in a date) is dropped.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter((phrase, i) => i === 0 || phrase.start >= (found[i - 1]?.end ?? 0));
}

/** Where each list item of a sentence starts (split at commas, "y", "pero", "aunque"). */
function segmentStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(SEGMENT_BREAK)) starts.push(match.index + match[0].length);
  return starts;
}

function alnumCount(text: string): number {
  return text.replace(/[^a-z0-9]/g, '').length;
}

/**
 * The plan items of one sentence. Each item binds to its nearest timing:
 * the one written in its own list item ("TSH en 6 semanas, control en 3
 * meses"), else the next one ("HbA1c, perfil lipidico y creatinina en 3
 * meses", "perfil lipidico y microalbuminuria antes de la proxima
 * consulta"), else the previous one ("control en 3 meses con HbA1c y perfil
 * lipidico"). A frequency word ("control anual") binds only within its own
 * list item. Quotes run from the item's words to its timing when both are in
 * the same list item; otherwise they are the item's own words, so no quote
 * names another item's test.
 */
function sentencePlanItems(
  sentence: { text: string; start: number },
  noteDay: string | undefined,
  quoteOf: (start: number, end: number) => string,
): ModelPlanItem[] {
  const text = sentence.text;
  const phrases = timingPhrases(text, noteDay);
  if (phrases.length === 0) return [];
  const starts = segmentStarts(text);
  const segmentOf = (at: number): number => {
    let segment = 0;
    for (let i = 0; i < starts.length; i += 1) if ((starts[i] ?? 0) <= at) segment = i;
    return segment;
  };
  const segmentText = (at: number): string => {
    const segment = segmentOf(at);
    return text.slice(starts[segment] ?? 0, starts[segment + 1] ?? text.length);
  };
  const bind = (start: number): TimingPhrase | undefined => {
    const segment = segmentOf(start);
    const own = phrases.filter(
      (phrase) =>
        segmentOf(phrase.start) === segment &&
        !(phrase.periodic && notAPlanFrequency(segmentText(phrase.start))),
    );
    if (own.length > 0) {
      return own.reduce((best, phrase) =>
        Math.abs(phrase.start - start) < Math.abs(best.start - start) ? phrase : best,
      );
    }
    const linked = phrases.filter((phrase) => !phrase.periodic);
    return (
      linked.find((phrase) => phrase.start > start) ??
      linked.filter((phrase) => phrase.end <= start).at(-1)
    );
  };
  const quote = (start: number, end: number, phrase: TimingPhrase): string => {
    const together =
      segmentOf(phrase.start) === segmentOf(start) ||
      alnumCount(text.slice(start, end)) < MIN_QUOTE_ALNUM;
    return together
      ? quoteOf(
          sentence.start + Math.min(start, phrase.start),
          sentence.start + Math.max(end, phrase.end),
        )
      : quoteOf(sentence.start + start, sentence.start + end);
  };
  const excluded = (start: number, phrase: TimingPhrase): boolean => {
    const timingSegment = segmentAround(text, phrase.start, phrase.end);
    return (
      isConditional(timingSegment, text) ||
      isConditional(segmentText(start)) ||
      statesSuspension(segmentText(start))
    );
  };

  const items: ModelPlanItem[] = [];
  const seen = new Set<string>();
  const add = (
    kind: PlanItemKind,
    description: string,
    start: number,
    end: number,
    loinc: string | null,
    key: string,
  ): void => {
    const phrase = bind(start);
    if (phrase === undefined || excluded(start, phrase)) return;
    if (phrase.timing === null && kind !== 'lab' && kind !== 'imaging') return;
    const dedupe = `${key}|${JSON.stringify(phrase.timing)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    items.push({
      kind,
      description,
      timing: phrase.timing,
      loincCode: loinc,
      evidenceQuote: quote(start, end, phrase),
      confidence: 0.5,
    });
  };

  const tests = namedTests(text);
  let anyKeyword = tests.length > 0;
  for (const [kind, pattern] of KIND_PATTERNS) {
    const testsOfKind = tests.filter((test) => test.group.kind === kind);
    const keywords = [...text.matchAll(new RegExp(pattern.source, 'g'))];
    if (keywords.length > 0) anyKeyword = true;
    if ((kind === 'lab' || kind === 'imaging') && testsOfKind.length > 0) {
      // One item per named test ("perfil lipidico y microalbuminuria").
      for (const test of testsOfKind) {
        add(
          kind,
          test.group.label,
          test.start,
          test.end,
          kind === 'lab' ? (test.group.loinc[0] ?? null) : null,
          test.group.id,
        );
      }
      continue;
    }
    for (const match of keywords) {
      add(kind, DESCRIPTIONS[kind], match.index, match.index + match[0].length, null, kind);
    }
  }
  if (!anyKeyword) {
    // No plan word: the timing alone ("en 2 semanas"), quoted from the sentence start.
    const phrase = phrases.find((candidate) => !candidate.periodic);
    if (phrase?.timing && !excluded(0, phrase)) {
      items.push({
        kind: 'other',
        description: DESCRIPTIONS.other,
        timing: phrase.timing,
        loincCode: null,
        evidenceQuote: quoteOf(sentence.start, sentence.start + phrase.end),
        confidence: 0.5,
      });
    }
  }
  return items;
}

/** Fake-provider responder backed by {@link heuristicExtraction}. */
export const heuristicResponder: FakeResponder = (request) => {
  const note = readNoteFromMessages(request.messages);
  return note === undefined
    ? undefined
    : heuristicExtraction(note, readNoteDateFromMessages(request.messages));
};
