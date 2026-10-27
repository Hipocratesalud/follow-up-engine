import type { PlanItemKind } from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import { readNoteFromMessages } from './prompt.ts';
import { createQuoteIndex } from './quote.ts';
import type {
  ModelCondition,
  ModelExtraction,
  ModelMedication,
  ModelPlanItem,
  TimeUnit,
} from './schema.ts';
import {
  NUMBER_WORDS,
  UNIT_WORDS,
  findDischarge,
  isConditional,
  isNegatedMention,
  looksLikeMeasurement,
  parseAmount,
  segmentAround,
} from './signals.ts';

/**
 * A rule-based extractor that answers like a model would. It is what the
 * fake provider returns when no fixture matches, which gives the eval
 * harness an honest, offline baseline: the number a Meta model has to beat.
 * Regexes over normalized text (lowercase, no accents); quotes are taken
 * from the original note so they pass the verbatim check. It shares the
 * post-checks' reading of negation ("niega HTA"), conditional returns
 * ("volver si fiebre"), measurements ("Hemoglobina 10,8 g/dL") and
 * discharge ("se da de alta").
 */

interface ConditionPattern {
  readonly pattern: RegExp;
  readonly icd10: string;
  readonly display: string;
}

const CONDITION_PATTERNS: readonly ConditionPattern[] = [
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
  { pattern: /\b(embarazo|gestacion)\b/, icd10: 'Z34', display: 'pregnancy supervision' },
];

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNIT = String.raw`(dias|dia|semanas|semana|sem|meses|mes|anos|ano)`;
const RELATIVE_TIMING = new RegExp(String.raw`\b(?:en|cada) ${AMOUNT} ${UNIT}\b`);
const NEXT_TIMING = /\b(proximo mes|proxima semana|proximo ano|mes que viene)\b/;

const KIND_PATTERNS: readonly (readonly [PlanItemKind, RegExp])[] = [
  [
    'lab',
    /\b(hba1c|laboratorio|labs?|perfil lipidico|hemograma|tsh|t4|creatinina|glicemia|glucemia|examen de orina|uroanalisis|urocultivo|psa|ferritina|microalbuminuria|citologia)\b/,
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
const ABSOLUTE_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;

function sentences(normalized: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const pattern = /[^.;\n]+/g;
  for (let match = pattern.exec(normalized); match; match = pattern.exec(normalized)) {
    out.push({ text: match[0], start: match.index });
  }
  return out;
}

/** Runs the rule-based extraction on a note. Linear in the note length. */
export function heuristicExtraction(note: string): ModelExtraction {
  const index = createQuoteIndex(note);
  const normalized = index.normalized.text;
  const quoteOf = (start: number, end: number): string => index.spanOf(start, end)?.text ?? '';

  const conditions: ModelCondition[] = [];
  for (const { pattern, icd10, display } of CONDITION_PATTERNS) {
    const global = new RegExp(pattern.source, 'g');
    for (const match of normalized.matchAll(global)) {
      const end = match.index + match[0].length;
      if (isNegatedMention(normalized, match.index, end)) continue;
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
    const relative = RELATIVE_TIMING.exec(sentence.text);
    const next = NEXT_TIMING.exec(sentence.text);
    const absolute = ABSOLUTE_DATE.exec(sentence.text);
    const timingMatch = relative ?? next ?? absolute;
    if (!timingMatch) continue;
    const timingStart = sentence.start + timingMatch.index;
    if (
      isConditional(segmentAround(normalized, timingStart, timingStart + timingMatch[0].length))
    ) {
      continue;
    }
    let amount: number | null = 1;
    let unit: TimeUnit | null = 'month';
    let date: string | null = null;
    if (absolute && timingMatch === absolute) {
      const [, d = '', m = '', y = ''] = absolute;
      date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      amount = null;
      unit = null;
    } else if (relative?.[1] && relative[2]) {
      amount = parseAmount(relative[1]);
      unit = UNIT_WORDS[relative[2]] ?? 'day';
    } else if (next?.[1]) {
      unit = next[1].includes('semana') ? 'week' : next[1].includes('ano') ? 'year' : 'month';
    }
    const kinds = KIND_PATTERNS.filter(([, pattern]) => pattern.test(sentence.text)).map(
      ([kind]) => kind,
    );
    for (const kind of kinds.length > 0 ? kinds.slice(0, 2) : (['other'] as const)) {
      const pattern = KIND_PATTERNS.find(([k]) => k === kind)?.[1];
      const keyword = pattern?.exec(sentence.text);
      // Quote from the keyword (or sentence start) through the timing phrase.
      const from = sentence.start + Math.min(keyword?.index ?? 0, timingMatch.index);
      const to =
        sentence.start +
        Math.max(
          timingMatch.index + timingMatch[0].length,
          (keyword?.index ?? 0) + (keyword?.[0].length ?? 0),
        );
      planItems.push({
        kind,
        description: DESCRIPTIONS[kind],
        timing: { amount, unit, date },
        loincCode: null,
        evidenceQuote: quoteOf(from, to),
        confidence: 0.5,
      });
    }
  }

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
  };
}

/** Fake-provider responder backed by {@link heuristicExtraction}. */
export const heuristicResponder: FakeResponder = (request) => {
  const note = readNoteFromMessages(request.messages);
  return note === undefined ? undefined : heuristicExtraction(note);
};
