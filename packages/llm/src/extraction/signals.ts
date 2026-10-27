import type { PlanItemKind } from '@follow-up-engine/core';
import type { TimeUnit } from './schema.ts';

/**
 * Deterministic reading of Spanish clinical wording, shared by the
 * post-checks (which decide whether a model item is backed by the note) and
 * the rule-based baseline. Every function works on normalized text
 * (`normalizeForMatch`: lowercase, no accents, single spaces) and is linear
 * in its input.
 */

const WORD_BEFORE = '(?<![a-z0-9])';
const WORD_AFTER = '(?![a-z0-9])';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A whole-word, global regex matching any of `terms` (already normalized). */
export function termsPattern(terms: Iterable<string>): RegExp {
  const sorted = [...new Set(terms)].filter((t) => t !== '').sort((a, b) => b.length - a.length);
  return new RegExp(`${WORD_BEFORE}(?:${sorted.map(escapeRegExp).join('|')})${WORD_AFTER}`, 'g');
}

// ---------------------------------------------------------------- timing

export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
};

export const UNIT_WORDS: Readonly<Record<string, TimeUnit>> = {
  dia: 'day',
  dias: 'day',
  d: 'day',
  semana: 'week',
  semanas: 'week',
  sem: 'week',
  s: 'week',
  mes: 'month',
  meses: 'month',
  m: 'month',
  ano: 'year',
  anos: 'year',
};

const AMOUNT = String.raw`(\d+(?:[.,]\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const LONG_UNIT = String.raw`(dias|dia|semanas|semana|sem|meses|mes|anos|ano)`;
const ANY_UNIT = String.raw`(dias|dia|d|semanas|semana|sem|s|meses|mes|m|anos|ano)`;
/** "en 3 meses", "dentro de 15 dias", "a las 20 semanas", "cada 2 semanas", "ctrl en 6 sem". */
const ANCHORED_INTERVAL = new RegExp(
  String.raw`${WORD_BEFORE}(?:en|dentro de|al cabo de|tras|luego de|despues de|cada)\s?${AMOUNT}\s?${ANY_UNIT}${WORD_AFTER}`,
  'g',
);
/** "control 3 meses": a bare interval, unless it is an age, a duration or the past. */
const BARE_INTERVAL = new RegExp(
  String.raw`${WORD_BEFORE}${AMOUNT}\s?${LONG_UNIT}${WORD_AFTER}`,
  'g',
);
const NOT_FORWARD_BEFORE =
  /(?:^|\s)(?:de|hace|desde|durante|por|x|ultimos|ultimas|los|las|con|tiene|lleva|evolucion)\s*$/;
const NEXT_REFERENCE =
  /(?<![a-z0-9])(?:prox(?:im[oa]s?)?(?![a-z])|mes que viene|semana que viene|ano que viene)/;
const CALENDAR_DATE =
  /(?<![0-9])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![0-9])|(?<![a-z0-9])\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?![a-z])/;
/** A target gestational or postnatal age ("a las 20 semanas"): timing, but not an interval from today. */
const TARGET_AGE = new RegExp(
  String.raw`${WORD_BEFORE}a (?:los|las) ${AMOUNT}\s?${LONG_UNIT}${WORD_AFTER}`,
);
const PERIODIC =
  /(?<![a-z])(?:mensual|mensualmente|semanal|semanalmente|quincenal|anual|anualmente|trimestral|semestral)(?![a-z])/;

const NUMERIC_DATE = /(?<![0-9])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![0-9])/g;

/** Explicit `dd/mm/yyyy` dates written in `text`, as `YYYY-MM-DD`. */
export function writtenDates(text: string): string[] {
  return [...text.matchAll(NUMERIC_DATE)].map(
    ([, d = '', m = '', y = '']) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
  );
}

export interface Interval {
  readonly amount: number;
  readonly unit: TimeUnit;
}

export function parseAmount(raw: string): number {
  return NUMBER_WORDS[raw] ?? Number(raw.replace(',', '.'));
}

/** Forward-looking intervals stated in `text` ("en 3 meses"; not "de 10 anos" nor "hace 2 meses"). */
export function forwardIntervals(text: string): Interval[] {
  const out: Interval[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(ANCHORED_INTERVAL)) {
    const unit = UNIT_WORDS[match[2] ?? ''];
    if (match[1] !== undefined && unit) {
      out.push({ amount: parseAmount(match[1]), unit });
      seen.add(match.index + match[0].length);
    }
  }
  for (const match of text.matchAll(BARE_INTERVAL)) {
    if (seen.has(match.index + match[0].length)) continue;
    if (NOT_FORWARD_BEFORE.test(text.slice(Math.max(0, match.index - 24), match.index))) continue;
    const unit = UNIT_WORDS[match[2] ?? ''];
    if (match[1] !== undefined && unit) out.push({ amount: parseAmount(match[1]), unit });
  }
  return out;
}

/** Whether `text` states when something will happen: an interval, a date, "proximo control", "mensual". */
export function hasTimeExpression(text: string): boolean {
  return (
    forwardIntervals(text).length > 0 ||
    NEXT_REFERENCE.test(text) ||
    CALENDAR_DATE.test(text) ||
    TARGET_AGE.test(text) ||
    PERIODIC.test(text)
  );
}

const APPROX_DAYS: Readonly<Record<TimeUnit, number>> = { day: 1, week: 7, month: 30, year: 365 };

export function approxDays(interval: Interval): number {
  return interval.amount * APPROX_DAYS[interval.unit];
}

// ---------------------------------------------------------------- plan wording

const KIND_TERMS: Readonly<Record<PlanItemKind, readonly string[]>> = {
  lab: [
    'hba1c',
    'hb a1c',
    'a1c',
    'hemoglobina glicosilada',
    'hemoglobina glicada',
    'laboratorio',
    'laboratorios',
    'lab',
    'labs',
    'examen',
    'examenes',
    'analisis',
    'perfil lipidico',
    'perfil tiroideo',
    'perfil hepatico',
    'perfil renal',
    'hemograma',
    'hematologia',
    'tsh',
    't4',
    't4 libre',
    't3',
    'creatinina',
    'urea',
    'glicemia',
    'glucemia',
    'glucosa',
    'k',
    'k+',
    'potasio',
    'sodio',
    'electrolitos',
    'orina',
    'uroanalisis',
    'urocultivo',
    'cultivo',
    'psa',
    'ferritina',
    'hierro',
    'microalbuminuria',
    'citologia',
    'papanicolaou',
    'pap',
    'colesterol',
    'trigliceridos',
    'transaminasas',
    'acido urico',
    'vitamina d',
    'serologia',
    'vih',
    'vdrl',
    'coprologico',
    'heces',
    'prueba',
    'pruebas',
    'resultados',
  ],
  imaging: [
    'eco',
    'ecografia',
    'ecosonograma',
    'ecocardiograma',
    'rx',
    'radiografia',
    'tac',
    'tomografia',
    'rm',
    'rmn',
    'resonancia',
    'mamografia',
    'densitometria',
    'doppler',
    'imagen',
    'imagenes',
  ],
  session: [
    'sesion',
    'sesiones',
    'fisioterapia',
    'kinesiologia',
    'kinesioterapia',
    'psicoterapia',
    'terapia',
    'terapias',
    'rehabilitacion',
    'proceso',
    'encuentro',
  ],
  follow_up_visit: [
    'control',
    'controles',
    'ctrl',
    'cita',
    'consulta',
    'reevaluar',
    'reevaluacion',
    'revision',
    'revisar',
    'seguimiento',
    'volver',
    'regresar',
    'retorno',
    'acudir',
    'visita',
    'valoracion',
    'evaluacion',
  ],
  other: [
    'referir',
    'referencia',
    'referido',
    'referida',
    'interconsulta',
    'derivar',
    'derivacion',
    'valoracion por',
    'evaluacion por',
    'cirugia',
    'procedimiento',
    'biopsia',
    'colposcopia',
    'fondo de ojo',
    'oftalmologia',
    'psiquiatria',
    'nutricion',
    'cardiologia',
    'vacuna',
    'vacunacion',
  ],
};

const KIND_PATTERNS = Object.fromEntries(
  Object.entries(KIND_TERMS).map(([kind, terms]) => [kind, termsPattern(terms)]),
) as Readonly<Record<PlanItemKind, RegExp>>;
const ANY_PLAN_PATTERN = termsPattern(Object.values(KIND_TERMS).flat());

function test(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}

/** The first match of a kind's wording in `text`, if any. */
export function findKindKeyword(kind: PlanItemKind, text: string): RegExpExecArray | null {
  const pattern = KIND_PATTERNS[kind];
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match;
}

/**
 * Whether `quote` names the kind of plan item it supports ("HbA1c" for a
 * lab, "eco" for imaging, "ctrl" for a visit). Items of kind `other` accept
 * any plan wording, since referrals and procedures are open-ended.
 */
export function hasKindKeyword(kind: PlanItemKind, quote: string): boolean {
  return test(kind === 'other' ? ANY_PLAN_PATTERN : KIND_PATTERNS[kind], quote);
}

const CONDITIONAL =
  /(?<![a-z])(?:solo si|solamente si|unicamente si|en caso de|si persiste|si persisten|si presenta|si empeora|si aparece|si aparecen|si hay|de ser necesario|si es necesario|segun necesidad|a necesidad|prn|sos|si lo requiere|si lo desea|si requiere)(?![a-z])/;
const SCHEDULED_ANYWAY = /(?<![a-z])(?:o antes|antes si|antes de ser necesario)(?![a-z])/;

/**
 * Whether a plan phrase only applies on a condition ("ctrl en 1 semana solo
 * si persisten los sintomas", "volver en caso de fiebre"): not a scheduled
 * follow-up. "Control en 1 mes o antes si empeora" is scheduled.
 */
export function isConditional(segment: string): boolean {
  return CONDITIONAL.test(segment) && !SCHEDULED_ANYWAY.test(segment);
}

// ---------------------------------------------------------------- clauses

const CLAUSE_BREAK = /[;\n]|\.(?!\d)|(?<![a-z])(?:pero|aunque|sin embargo)(?![a-z])/g;
const SEGMENT_BREAK = /[;,\n]|\.(?!\d)|(?<![a-z])(?:y|pero|aunque)(?![a-z])/g;

function boundsAround(text: string, start: number, end: number, breaks: RegExp): [number, number] {
  let from = 0;
  let to = text.length;
  breaks.lastIndex = 0;
  for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
    const breakEnd = match.index + match[0].length;
    if (breakEnd <= start) from = breakEnd;
    else if (match.index >= end) {
      to = match.index;
      break;
    }
    if (match[0].length === 0) breaks.lastIndex += 1;
  }
  breaks.lastIndex = 0;
  return [from, to];
}

/** The sentence-like clause of `text` that contains `[start, end)` (split at . ; newline, "pero"). */
export function clauseAround(text: string, start: number, end: number): string {
  const [from, to] = boundsAround(text, start, end, CLAUSE_BREAK);
  return text.slice(from, to);
}

/** The narrower segment around `[start, end)` (also split at commas and "y"). */
export function segmentAround(text: string, start: number, end: number): string {
  const [from, to] = boundsAround(text, start, end, SEGMENT_BREAK);
  return text.slice(from, to);
}

/** Like {@link clauseAround}, but returns the clause start offset too. */
export function clauseBoundsAround(text: string, start: number, end: number): [number, number] {
  return boundsAround(text, start, end, CLAUSE_BREAK);
}

// ---------------------------------------------------------------- conditions

const NEGATION_CUES =
  /(?<![a-z])(?:niega|niegan|nego|negando|descarta|descartado|descartada|descartandose|no presenta|no refiere|no tiene|no hay|no se evidencia|no se observa|no impresiona|negativo para|negativa para|ausencia de|libre de|sin antecedentes? de|sin evidencia de|sin signos de)(?![a-z])/g;
const SIN = /(?<![a-z])sin(?![a-z])/g;
const NEGATION_AFTER = /^\s*(?:[:(]\s*)?(?:descartad[oa]s?|negativ[oa]s?|\(-\)|-\s|ausente)/;
const HEDGE_CUES =
  /(?<![a-z])(?:sospecha|sospechoso|sospechosa|probable|posible|presunto|presunta|a descartar|descartar|d\/c|r\/o|impresion diagnostica de posible)(?![a-z])/g;
const HEDGE_AFTER = /^\s*(?:\?|en estudio|a descartar|por descartar|vs\.?(?![a-z]))/;

function lastTokens(text: string, count: number): string {
  const tokens = text.trim().split(/\s+/);
  return tokens.slice(Math.max(0, tokens.length - count)).join(' ');
}

/**
 * Whether the mention at `[start, end)` of `text` is negated: "niega HTA y
 * diabetes", "sin antecedentes de DM2", "HTA descartada". Looks back within
 * the clause (eight words; three for a bare "sin") and two words ahead.
 */
export function isNegatedMention(text: string, start: number, end: number): boolean {
  const [clauseStart] = clauseBoundsAround(text, start, end);
  const before = text.slice(clauseStart, start);
  const window = lastTokens(before, 8);
  NEGATION_CUES.lastIndex = 0;
  const negated = NEGATION_CUES.test(window);
  NEGATION_CUES.lastIndex = 0;
  if (negated) return true;
  // A bare "sin" negates only within its own list item: "sin HTA", not "DM2 sin complicaciones, HTA".
  const item = before.slice(Math.max(before.lastIndexOf(','), 0));
  SIN.lastIndex = 0;
  const sin = SIN.test(lastTokens(item, 3));
  SIN.lastIndex = 0;
  if (sin) return true;
  return NEGATION_AFTER.test(text.slice(end, end + 24));
}

/** Whether the mention is only suspected ("sospecha de hipotiroidismo", "DM2?", "astenia en estudio"). */
export function isHedgedMention(text: string, start: number, end: number): boolean {
  const [clauseStart] = clauseBoundsAround(text, start, end);
  HEDGE_CUES.lastIndex = 0;
  const hedged = HEDGE_CUES.test(lastTokens(text.slice(clauseStart, start), 6));
  HEDGE_CUES.lastIndex = 0;
  return hedged || HEDGE_AFTER.test(text.slice(end, end + 24));
}

// ---------------------------------------------------------------- discharge

const DISCHARGE =
  /(?<![a-z])(?:se (?:le )?(?:da|otorga|indica|decide|firma) (?:el )?(?:de )?alta|dad[oa] de alta|doy de alta|damos de alta|alta (?:medica|definitiva|terapeutica|del servicio|por mejoria|de (?:psicologia|fisioterapia|terapia|consulta|ginecologia|medicina interna|la consulta|la especialidad))|egreso del (?:programa|proceso|servicio)|cierre del proceso(?: terapeutico)?|fin del (?:proceso|tratamiento|seguimiento)(?: terapeutico)?)(?![a-z])/g;
const DISCHARGE_CLAUSE = /^(?:plan\s*:?\s*)?alta(?:\s+(?:medica|definitiva|por mejoria))?\s*$/;
const DISCHARGE_NEGATION =
  /(?<![a-z])(?:no|aun no|todavia no|sin|pendiente|se difiere|difiere)\s+(?:se\s+(?:le\s+)?)?$/;

/** Where a discharge statement starts and ends in `text` ("se da de alta"), or `undefined`. */
export function findDischarge(text: string): { start: number; end: number } | undefined {
  DISCHARGE.lastIndex = 0;
  for (let match = DISCHARGE.exec(text); match; match = DISCHARGE.exec(text)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!DISCHARGE_NEGATION.test(before)) {
      DISCHARGE.lastIndex = 0;
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  DISCHARGE.lastIndex = 0;
  let offset = 0;
  for (const clause of text.split(/[;\n]|\.(?!\d)/)) {
    const trimmed = clause.trim();
    if (DISCHARGE_CLAUSE.test(trimmed)) {
      const start = offset + clause.indexOf(trimmed);
      return { start, end: start + trimmed.length };
    }
    offset += clause.length + 1;
  }
  return undefined;
}

/** Whether `text` (a quote) states a discharge. */
export function statesDischarge(text: string): boolean {
  return findDischarge(text) !== undefined;
}

// ---------------------------------------------------------------- medications

const CONCENTRATION =
  /\d\s*(?:g|mg|ug|mcg|ng|pg|meq|mmol|umol|ui|u|mui|mu|cel|celulas)\s*\/\s*(?:dl|l|ul|mm3|24 ?h)(?![a-z])|\d\s*(?:mmhg|lpm|rpm|kg\/m2)(?![a-z])/;
const LAB_ANALYTE =
  /^(?:hemoglobina|hb|hba1c|a1c|hematocrito|hto|glicemia|glucemia|glucosa|colesterol|ldl|hdl|trigliceridos|creatinina|urea|tsh|t4|t3|ferritina|plaquetas|leucocitos|psa|acido urico|tfg|filtrado|microalbuminuria|vsg|pcr|ta|pa|fc|fr|imc|peso|talla|temperatura)(?![a-z])/;

/** Whether a "medication" is really a measurement ("Hemoglobina 10,8 g/dL", "HbA1c 7.4%"). */
export function looksLikeMeasurement(text: string): boolean {
  return CONCENTRATION.test(text) || LAB_ANALYTE.test(text.trim());
}
