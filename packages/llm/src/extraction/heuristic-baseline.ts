import type { PlanItemKind } from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import { namedTests } from './lab-tests.ts';
import { readNoteDateFromMessages, readNoteFromMessages } from './prompt.ts';
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
  conditionContext,
  findDischarge,
  isConditional,
  isNegatedMention,
  looksLikeMeasurement,
  parseAmount,
  segmentAround,
  statedTiming,
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
 * proxima consulta" due with the next control).
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
  { pattern: /\b(embarazo|gestacion)\b/, icd10: 'Z34', display: 'pregnancy supervision' },
];

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNIT = String.raw`(dias|dia|semanas|semana|sem|meses|mes|anos|ano)`;
const RELATIVE_TIMING = new RegExp(String.raw`\b(?:en|cada) ${AMOUNT} ${UNIT}\b`);
const NEXT_TIMING = /\b(proximo mes|proxima semana|proximo ano|mes que viene)\b/;

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
const ABSOLUTE_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
const NAMED_DATE =
  /\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/;
/** "antes de la proxima consulta", "al proximo control": due with the next visit. */
const WITH_NEXT_VISIT =
  /\b(?:antes de|para|a|al|en) (?:la |el )?prox(?:im[oa])?\.? (?:control|ctrl|cita|consulta|visita)\b/;

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
  const keyword = (kind: PlanItemKind, text: string): RegExpExecArray | null =>
    KIND_PATTERNS.find(([k]) => k === kind)?.[1].exec(text) ?? null;
  for (const sentence of sentences(normalized)) {
    const relative = RELATIVE_TIMING.exec(sentence.text);
    const next = NEXT_TIMING.exec(sentence.text);
    const absolute = ABSOLUTE_DATE.exec(sentence.text);
    const named = noteDay === undefined ? null : NAMED_DATE.exec(sentence.text);
    const withNextVisit = WITH_NEXT_VISIT.exec(sentence.text);
    const timingMatch = relative ?? next ?? absolute ?? named ?? withNextVisit;
    if (!timingMatch) continue;
    const timingStart = sentence.start + timingMatch.index;
    const segment = segmentAround(normalized, timingStart, timingStart + timingMatch[0].length);
    if (isConditional(segment, sentence.text)) continue;
    let timing: ModelPlanItem['timing'] = { amount: 1, unit: 'month', date: null };
    if (timingMatch === absolute) {
      const [, d = '', m = '', y = ''] = absolute;
      timing = {
        amount: null,
        unit: null,
        date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
      };
    } else if (timingMatch === named && noteDay !== undefined) {
      const date = statedTiming(named[0], noteDay).dates[0];
      timing = date === undefined ? null : { amount: null, unit: null, date };
    } else if (timingMatch === withNextVisit) {
      timing = null;
    } else if (relative?.[1] && relative[2]) {
      timing = {
        amount: parseAmount(relative[1]),
        unit: UNIT_WORDS[relative[2]] ?? 'day',
        date: null,
      };
    } else if (next?.[1]) {
      const unit: TimeUnit = next[1].includes('semana')
        ? 'week'
        : next[1].includes('ano')
          ? 'year'
          : 'month';
      timing = { amount: 1, unit, date: null };
    }
    // Quote from the item's words (or sentence start) through the timing phrase.
    const quoteAround = (from: number, to: number): string =>
      quoteOf(
        sentence.start + Math.min(from, timingMatch.index),
        sentence.start + Math.max(to, timingMatch.index + timingMatch[0].length),
      );
    const add = (kind: PlanItemKind, description: string, quote: string, loinc: string | null) => {
      planItems.push({
        kind,
        description,
        timing,
        loincCode: loinc,
        evidenceQuote: quote,
        confidence: 0.5,
      });
    };
    const kinds = KIND_PATTERNS.filter(([, pattern]) => pattern.test(sentence.text)).map(
      ([kind]) => kind,
    );
    const tests = namedTests(sentence.text);
    for (const kind of kinds.length > 0 ? kinds : (['other'] as const)) {
      if (timing === null && kind !== 'lab' && kind !== 'imaging') continue;
      const testsOfKind = tests.filter((test) => test.group.kind === kind);
      if ((kind === 'lab' || kind === 'imaging') && testsOfKind.length > 0) {
        // One item per named test ("perfil lipidico y microalbuminuria").
        const seen = new Set<string>();
        for (const test of testsOfKind) {
          if (seen.has(test.group.id)) continue;
          seen.add(test.group.id);
          add(
            kind,
            test.group.label,
            quoteAround(test.start, test.end),
            kind === 'lab' ? (test.group.loinc[0] ?? null) : null,
          );
        }
        continue;
      }
      const match = keyword(kind, sentence.text);
      add(
        kind,
        DESCRIPTIONS[kind],
        quoteAround(match?.index ?? 0, (match?.index ?? 0) + (match?.[0].length ?? 0)),
        null,
      );
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
  return note === undefined
    ? undefined
    : heuristicExtraction(note, readNoteDateFromMessages(request.messages));
};
