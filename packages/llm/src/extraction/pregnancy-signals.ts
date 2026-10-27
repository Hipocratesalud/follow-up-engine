import type { PregnancyOutcomeKind } from './types.ts';
import {
  NUMBER_WORDS,
  clauseBoundsAround,
  isNegatedMention,
  isObstetricHistoryMention,
  isPastPregnancyMention,
  parseAmount,
} from './signals.ts';

/**
 * Deterministic reading of how Spanish notes date a pregnancy and report
 * its outcome, shared by the post-checks (which verify a model's reading
 * against the note) and the rule-based baseline. Every function works on
 * normalized text (`normalizeForMatch`: lowercase, no accents, single
 * spaces) and is linear in its input.
 */

const MS_PER_DAY = 86_400_000;

function lastTokens(text: string, count: number): string {
  const tokens = text.trim().split(/\s+/);
  return tokens.slice(Math.max(0, tokens.length - count)).join(' ');
}

// ---------------------------------------------------------------- current pregnancy

/** Words that put a pregnancy in the note ("embarazo", "gestante", "EG", "FPP", "control prenatal"). */
const PREGNANCY_WORDS =
  /(?<![a-z])(?:embarazo|embarazada|gestante|gestacion|primigesta|multigesta|secundigesta|edad gestacional|eg|control prenatal|cpn|fpp|fecha probable de parto)(?![a-z])/g;
/** What makes a pregnancy word not a current pregnancy when it comes right before it. */
const NOT_A_PREGNANCY_BEFORE =
  /(?:^|\s)(?:prueba de|prueba|test de|test|deseo de|desea|desean|busca|buscando|buscan|planifica|planificacion de|planificar|evitar|prevenir|prevencion de|riesgo de|interrupcion del|en caso de|posibilidad de|descartar|descarta|d\/c|sospecha de|no|no esta|niega)(?: (?:un |una )?(?:nuevo|nueva|otro|otra|segundo|segunda))?\s*$/;
const NOT_A_PREGNANCY_AFTER =
  /^\s?(?:ectopico|molar|anembrionado|previos?|previas?|anteriores?|negativ[oa]|\(-\)|descartad[oa])(?![a-z])/;
const POSITIVE_TEST_AFTER =
  /^\s?(?:en (?:orina|sangre) |cualitativa |cuantitativa |\(?b-?hcg\)? )?(?:positiv[oa]|\(\+\))(?![a-z])/;

/**
 * Whether the note states that the patient is pregnant now: a pregnancy
 * word ("embarazo de 20 semanas", "gestante", "EG", "FPP", "control
 * prenatal") that is not denied ("niega embarazo", "prueba de embarazo
 * negativa"), not a wish or a test ("desea embarazo", "prueba de
 * embarazo"), not a past pregnancy ("embarazo previo", "G2P1" alone) and
 * not a loss ("embarazo ectopico"), or a gestational age ("G2P1, 20 sem").
 * A routine "FUM" alone is not one.
 */
export function statesCurrentPregnancy(text: string): boolean {
  for (const match of text.matchAll(PREGNANCY_WORDS)) {
    const start = match.index;
    const end = start + match[0].length;
    const after = text.slice(end, end + 24);
    const [clauseStart] = clauseBoundsAround(text, start, end);
    const before = lastTokens(text.slice(clauseStart, start), 3);
    if (NOT_A_PREGNANCY_AFTER.test(after)) continue;
    if (NOT_A_PREGNANCY_BEFORE.test(before) && !POSITIVE_TEST_AFTER.test(after)) continue;
    if (isNegatedMention(text, start, end)) continue;
    if (isPastPregnancyMention(text, start, end)) continue;
    return true;
  }
  // "G2P1, 20 sem": a gestational age is a pregnancy word of its own.
  return gestationalAges(text).length > 0;
}

// ---------------------------------------------------------------- gestational age

/** A gestational age written in the note ("embarazo de 20 semanas y 3 dias", "EG: 20+3", "20 sem"). */
export interface GestationalAge {
  readonly weeks: number;
  readonly days?: number;
  /** Range in the normalized text, including a leading "EG:" or "embarazo de" when present. */
  readonly start: number;
  readonly end: number;
}

const GA_UNIT = String.raw`(?:semanas|semana|sem|ss|sdg|s)`;
const GA_NUMBER = new RegExp(
  String.raw`(?<![0-9a-z/.,+])(\d{1,2})(?![0-9])(?:\s?\+\s?(\d)(?![0-9]))?(?:\s?(${GA_UNIT})(?![a-z0-9]))?(?:\s?(?:y|con|\+)\s?(\d)\s?(?:dias|dia|d)(?![a-z0-9]))?`,
  'g',
);
/** "EG:", "edad gestacional de" right before the number. */
const GA_LABEL_BEFORE = /(?:^|\s)(?:eg|ega|edad gestacional)\s?:?\s?(?:de\s)?$/;
/** A pregnancy word somewhere before the number ("embarazo de", "gestante de", "G2P1,"). */
const GA_CUE =
  /(?<![a-z0-9])(?:embarazo|embarazada|gestacion|gestante|primigesta|multigesta|secundigesta|cursando|eg|ega|edad gestacional|g ?\d{1,2},? ?p ?\d{1,2}(?:,? ?[ac] ?\d{1,2})*)(?![a-z0-9])/g;
/** Words after the number that make it a gestational age on their own ("20 semanas de gestacion"). */
const GA_AFTER =
  /^\s?(?:de (?:gestacion|embarazo|amenorrea)|por (?:fum|fur|eco)|x (?:fum|fur|eco))(?![a-z])/;
/** Words before the number that make it a duration, an interval or a target age, not today's age. */
const NOT_GA_BEFORE =
  /(?:^|\s)(?:hace|desde|durante|por|x|en|cada|tras|a las|a los|las|los|dentro de|luego de|despues de|lleva|llevaba|evolucion de|ultimas|proximas|mas de|menos de|al menos)\s?$/;
const NOT_GA_AFTER =
  /^\s?(?:de evolucion|postparto|posparto|post parto|post-parto|de puerperio|despues|antes|atras)(?![a-z])/;
const PAST_NEAR = /(?<![a-z])(?:previ[oa]s?|anterior(?:es)?)(?![a-z])/;
/** Text between a pregnancy word and the number: a few words, no other number. */
const GA_GAP = /^[a-z\s,:;()-]{0,40}$/;

/**
 * Gestational ages written in `text`, first to last, in the forms Spanish
 * notes use: "embarazo de 20 semanas", "embarazo de 20 semanas y 3 dias",
 * "20 sem", "G2P1, 20 sem", "EG 20 sem", "EG: 20+3", "20 semanas de
 * gestacion". A number counts only after a pregnancy word (with no other
 * number in between) or with "EG"; never a duration ("dolor de 2 semanas"
 * after the dating), an interval ("control en 4 semanas"), a target age
 * ("eco a las 20 semanas") or a past pregnancy ("embarazo previo de 38
 * semanas").
 */
export function gestationalAges(text: string): GestationalAge[] {
  const ages: GestationalAge[] = [];
  for (const match of text.matchAll(GA_NUMBER)) {
    const [whole, rawWeeks = '', plusDays, unit, unitDays] = match;
    const start = match.index;
    const end = start + whole.length;
    const [clauseStart] = clauseBoundsAround(text, start, end);
    const before = text.slice(clauseStart, start);
    const labeled = GA_LABEL_BEFORE.exec(before);
    if (unit === undefined && plusDays === undefined && labeled === null) continue;
    if (unit === undefined && unitDays !== undefined) continue;
    if (NOT_GA_BEFORE.test(before) || NOT_GA_AFTER.test(text.slice(end, end + 24))) continue;
    let cued = labeled !== null || GA_AFTER.test(text.slice(end, end + 24));
    let cueStart = labeled === null ? start : start - labeled[0].length;
    if (!cued) {
      let cue: { start: number; end: number } | undefined;
      for (const found of before.matchAll(GA_CUE)) {
        cue = { start: found.index, end: found.index + found[0].length };
      }
      cued = cue !== undefined && GA_GAP.test(before.slice(cue.end));
      if (cue !== undefined) cueStart = clauseStart + cue.start;
    }
    if (!cued) continue;
    // "embarazo previo de 38 semanas", "embarazo de 38 semanas anterior", under "AGO:".
    if (
      PAST_NEAR.test(text.slice(cueStart, end + 12)) ||
      isPastPregnancyMention(text, start, end)
    ) {
      continue;
    }
    const weeks = Number(rawWeeks);
    if (weeks < 1 || weeks > 45) continue;
    const days = plusDays ?? unitDays;
    const lead =
      /(?:(?:eg|ega|edad gestacional)\s?:?\s?(?:de\s)?|(?:embarazo|gestacion|gestante|embarazada) de\s)$/.exec(
        before,
      );
    ages.push({
      weeks,
      ...(days === undefined ? {} : { days: Number(days) }),
      start: lead ? start - lead[0].length : start,
      end: end - (/\s$/.test(whole) ? 1 : 0),
    });
  }
  return ages;
}

// ---------------------------------------------------------------- written dates

const MONTHS: Readonly<Record<string, number>> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');

/** A calendar day written in the note, its year only when written. */
export interface WrittenDay {
  readonly day: number;
  readonly month: number;
  readonly year?: number;
  readonly start: number;
  readonly end: number;
}

/** "03/04/2026", "3-4-26", "3/4", "3 de abril de 2026", "3 abril". Day first, as Latin America writes it. */
const WRITTEN_DAY = new RegExp(
  String.raw`(?<![0-9/.-])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?![0-9/])|(?<![0-9])(\d{1,2})(?: de)? (${MONTH_NAMES})(?:,? (?:de |del )?(\d{4}))?(?![a-z0-9])`,
  'g',
);

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Calendar days written in `text`, first to last (a year only when written). */
export function writtenDays(text: string): WrittenDay[] {
  const days: WrittenDay[] = [];
  for (const match of text.matchAll(WRITTEN_DAY)) {
    const day = Number(match[1] ?? match[4]);
    const month = match[2] !== undefined ? Number(match[2]) : (MONTHS[match[5] ?? ''] ?? 0);
    const rawYear = match[3] ?? match[6];
    const year =
      rawYear === undefined
        ? undefined
        : rawYear.length === 2
          ? 2000 + Number(rawYear)
          : Number(rawYear);
    if (month < 1 || month > 12 || !validDay(year ?? 2024, month, day)) continue;
    days.push({
      day,
      month,
      ...(year === undefined ? {} : { year }),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return days;
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The `YYYY-MM-DD` of a written day. A missing year is the one that puts
 * the day where it can be: `past` is the latest such day on or before the
 * note (a last period, a delivery), `upcoming` the earliest on or after four
 * weeks before the note (an estimated delivery date).
 */
export function resolveWrittenDay(
  written: WrittenDay,
  noteDay: string,
  direction: 'past' | 'upcoming',
): string | undefined {
  if (written.year !== undefined) {
    return validDay(written.year, written.month, written.day)
      ? isoOf(written.year, written.month, written.day)
      : undefined;
  }
  const noteYear = Number(noteDay.slice(0, 4));
  const years =
    direction === 'past' ? [noteYear, noteYear - 1] : [noteYear - 1, noteYear, noteYear + 1];
  const floor = new Date(Date.parse(`${noteDay}T00:00:00Z`) - 28 * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  for (const year of years) {
    if (!validDay(year, written.month, written.day)) continue;
    const iso = isoOf(year, written.month, written.day);
    if (direction === 'past' ? iso <= noteDay : iso >= floor) return iso;
  }
  return undefined;
}

/** Whether `iso` (`YYYY-MM-DD`) is one of the days written in `text`, by day and month, and by year when written. */
export function isWrittenDay(text: string, iso: string): boolean {
  const [year, month, day] = iso.split('-').map(Number);
  return writtenDays(text).some(
    (w) => w.day === day && w.month === month && (w.year === undefined || w.year === year),
  );
}

/** A date written after a dating label: "FUM 03/04/2026", "FPP: 10/01/2027". */
export interface LabeledDate {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** From the label to the end of the date, in the normalized text. */
  readonly start: number;
  readonly end: number;
}

const LMP_LABEL = new RegExp(
  String.raw`(?<![a-z])(?:fum|fur|f\.u\.m\.?|f\.u\.r\.?|fecha de (?:la )?ultima (?:menstruacion|regla)|ultima menstruacion|ultima regla)(?![a-z])`,
  'g',
);
const EDD_LABEL = new RegExp(
  String.raw`(?<![a-z])(?:fpp|f\.p\.p\.?|fecha probable de parto|fecha probable del parto|fecha estimada de parto)(?![a-z])`,
  'g',
);
/** What may stand between a label and its date: "FPP por eco: ", "FUM el ". */
const LABEL_GAP =
  /^\s?(?:(?:por|x|segun) (?:eco|ecografia|usg|fum|fur)\s?)?(?:[:=-]\s?)?(?:(?:el|del|de)\s)?$/;

function labeledDates(
  text: string,
  label: RegExp,
  noteDay: string,
  direction: 'past' | 'upcoming',
): LabeledDate[] {
  const days = writtenDays(text);
  const out: LabeledDate[] = [];
  for (const match of text.matchAll(label)) {
    const labelEnd = match.index + match[0].length;
    const written = days.find((d) => d.start >= labelEnd && d.start - labelEnd <= 24);
    if (written === undefined || !LABEL_GAP.test(text.slice(labelEnd, written.start))) continue;
    const date = resolveWrittenDay(written, noteDay, direction);
    if (date !== undefined) out.push({ date, start: match.index, end: written.end });
  }
  return out;
}

const DATING_LABEL_BEFORE = new RegExp(
  String.raw`(?:${LMP_LABEL.source}|${EDD_LABEL.source})${LABEL_GAP.source.slice(1)}`,
);

/**
 * Whether the date written at `start` of `text` is a dating date ("FUM
 * 03/04/2026", "FPP por eco: 10/01/2027"): a pregnancy's dates, not a
 * follow-up's.
 */
export function isDatingDate(text: string, start: number): boolean {
  return DATING_LABEL_BEFORE.test(text.slice(Math.max(0, start - 40), start));
}

/** Last menstrual periods written in `text` ("FUM 03/04/2026", "FUR: 3/4/26"), a missing year in the past. */
export function lastMenstrualPeriods(text: string, noteDay: string): LabeledDate[] {
  return labeledDates(text, LMP_LABEL, noteDay, 'past');
}

/** Estimated delivery dates written in `text` ("FPP 10/01/2027", "FPP por eco: 10/01/2027"). */
export function estimatedDeliveryDates(text: string, noteDay: string): LabeledDate[] {
  return labeledDates(text, EDD_LABEL, noteDay, 'upcoming');
}

/** Whether a quote says anything that dates a pregnancy: weeks, "EG", "FUM", "FPP" or a pregnancy word. */
export function namesDating(quote: string): boolean {
  return (
    new RegExp(String.raw`(?<![0-9])\d{1,2}\s?(?:\+\s?\d|${GA_UNIT}(?![a-z]))`).test(quote) ||
    new RegExp(LMP_LABEL.source).test(quote) ||
    new RegExp(EDD_LABEL.source).test(quote) ||
    new RegExp(PREGNANCY_WORDS.source).test(quote)
  );
}

// ---------------------------------------------------------------- outcome

/** Why a delivery or loss mention is not this pregnancy's outcome. */
export type OutcomeExclusion = 'negated' | 'not_current' | 'quote_unrelated';

/** A delivery or loss mentioned in the note. */
export interface OutcomeMention {
  /** Undefined for a puerperium word ("puerpera"), which says there was a delivery but not how. */
  readonly kind?: PregnancyOutcomeKind;
  readonly start: number;
  readonly end: number;
  /** Set when the mention is not this pregnancy's outcome. */
  readonly excluded?: OutcomeExclusion;
}

/**
 * Delivery and loss words (singular only: "partos: 2" and "abortos: 1" are
 * tallies of past pregnancies). Groups: 1 caesarean, 2 loss, 3 vaginal
 * delivery, 4 puerperium.
 */
const OUTCOME_WORDS =
  /(?<![a-z])(?:(parto (?:por |via )?cesar[ei]a|(?:operacion )?cesar[ei]a(?: segmentaria(?: transperitoneal)?| iterativa| de urgencia| de emergencia| electiva)?)|(aborto(?: (?:espontaneo|incompleto|completo|diferido|retenido|septico|inevitable|en curso)){0,2}|perdida (?:gestacional|del embarazo|de la gestacion|fetal)|obito(?: fetal)?|muerte fetal|embarazo ectopico|ectopico roto|embarazo molar|mola hidatiforme)|(parto(?: (?:vaginal|eutocico|normal|distocico|instrumentado|pretermino|a termino|espontaneo|por via vaginal)){0,2})|(puerpera|puerperio|posparto|postparto|post parto|post-parto))(?![a-z])/g;
/** Words before a delivery or loss word that make it planned, threatened or hypothetical. */
const NOT_AN_OUTCOME_BEFORE =
  /(?:^|\s)(?:amenaza de|riesgo de|signos de|sintomas de|trabajo de|inicio de|plan de|preparacion para(?: el)?|curso de|via de|via del|via|candidata a|programar|programacion de|se programa|fecha de|fecha probable de|fecha probable del|indicacion de|se indica|planificar|planifica|para|para el|para la|antes de|antes del|hasta el|evitar|prevencion de|prevenir|desea|deseo de|tipo de|(?:control|ctrl|cita|consulta|visita)(?: de| del| en el)?|anticoncepcion|metodo|en el|durante el|depresion|lactancia)\s*$/;
const NOT_AN_OUTCOME_AFTER =
  /^\s?(?:programad[oa]|prevista|previsto|planificad[oa]|pendiente|por programar|electiva (?:programada|para))(?![a-z])/;

/**
 * Delivery and loss mentions in `text`, first to last, each with the reason
 * it is not this pregnancy's outcome when it is not: denied ("niega
 * abortos" is a tally anyway, "sin aborto"), history ("cesarea previa",
 * "antecedente de aborto", "2 partos", "parto vaginal en 2019" with
 * `noteYear`), or planned, threatened or hypothetical ("cesarea
 * programada", "amenaza de aborto", "via del parto", "control posparto").
 */
export function outcomeMentions(text: string, noteYear?: number): OutcomeMention[] {
  const mentions: OutcomeMention[] = [];
  for (const match of text.matchAll(OUTCOME_WORDS)) {
    const start = match.index;
    const end = start + match[0].length;
    const kind: PregnancyOutcomeKind | undefined =
      match[1] !== undefined
        ? 'cesarean_delivery'
        : match[2] !== undefined
          ? 'loss'
          : match[3] !== undefined
            ? 'vaginal_delivery'
            : undefined;
    const [clauseStart] = clauseBoundsAround(text, start, end);
    const before = lastTokens(text.slice(clauseStart, start), 4);
    const after = text.slice(end, end + 32);
    let excluded: OutcomeExclusion | undefined;
    if (isNegatedMention(text, start, end)) excluded = 'negated';
    else if (
      isObstetricHistoryMention(text, start, end, noteYear === undefined ? {} : { noteYear })
    ) {
      excluded = 'not_current';
    } else if (NOT_AN_OUTCOME_BEFORE.test(before) || NOT_AN_OUTCOME_AFTER.test(after)) {
      excluded = 'quote_unrelated';
    }
    mentions.push({
      ...(kind === undefined ? {} : { kind }),
      start,
      end,
      ...(excluded === undefined ? {} : { excluded }),
    });
  }
  return mentions;
}

const ELAPSED_UNITS: Readonly<Record<string, number>> = {
  dia: 1,
  dias: 1,
  d: 1,
  semana: 7,
  semanas: 7,
  sem: 7,
  mes: 30,
  meses: 30,
};
const ELAPSED = new RegExp(
  String.raw`(?<![a-z0-9])(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\s?(dias|dia|d|semanas|semana|sem|meses|mes)(?![a-z0-9])`,
  'g',
);
const FORWARD_BEFORE = /(?:^|\s)(?:en|cada|dentro de|a las|a los|proximos|proximas|luego de)\s?$/;
/** "a las 2 semanas de aborto": an elapsed time after all. */
const SINCE_AFTER = /^\s?(?:de|del|post|tras)\s/;

/**
 * Elapsed times written in `text`, in days ("hace 10 dias", "puerpera de
 * 10 dias", "6 semanas postparto", "a las 2 semanas de aborto", "ayer");
 * intervals ahead ("control en 6 semanas") are left out.
 */
export function statedElapsedDays(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(ELAPSED)) {
    const forward = FORWARD_BEFORE.test(text.slice(Math.max(0, match.index - 16), match.index));
    const since = SINCE_AFTER.test(text.slice(match.index + match[0].length));
    if (forward && !since) continue;
    const unit = ELAPSED_UNITS[match[2] ?? ''];
    if (unit !== undefined && match[1] !== undefined) out.push(parseAmount(match[1]) * unit);
  }
  if (/(?<![a-z])ayer(?![a-z])/.test(text)) out.push(1);
  return out;
}

/** How long ago an outcome happened, as the baseline reads it from its clause. */
const AGO_PHRASES = [
  new RegExp(
    String.raw`(?<![a-z])hace (\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')}) (dias|dia|semanas|semana|sem|meses|mes)(?![a-z])`,
  ),
  /(?<![a-z])(?:puerpera|puerperio)(?: [a-z]+)? de (\d{1,3}) (dias|dia|semanas|semana|sem|meses|mes)(?![a-z])/,
  /(?<![a-z0-9])(\d{1,3}) (dias|dia|semanas|semana|sem|meses|mes) (?:de |del )?(?:posparto|postparto|post parto|puerperio|despues|luego)(?![a-z])/,
  /(?<![a-z])a (?:las|los) (\d{1,3}) (dias|dia|semanas|semana|sem|meses|mes) (?:de|del|post|tras) (?:su |el |la )?(?:aborto|parto|cesarea|perdida|legrado)(?![a-z])/,
];

/** The first "hace N dias" / "puerpera de N dias" / "N dias postparto" of `clause`, in days. */
export function agoDays(clause: string): number | undefined {
  for (const phrase of AGO_PHRASES) {
    const match = phrase.exec(clause);
    const unit = ELAPSED_UNITS[match?.[2] ?? ''];
    if (match?.[1] !== undefined && unit !== undefined) return parseAmount(match[1]) * unit;
  }
  return undefined;
}
