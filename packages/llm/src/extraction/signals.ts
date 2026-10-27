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
/** "15/04/2026", "15-04-26", "15/04". */
const NUMERIC_DAY = /(?<![0-9/])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?![0-9/])/g;
/** "15 de abril", "15 de abril de 2026", "15 abril 2026". */
const NAMED_DAY = new RegExp(
  String.raw`(?<![0-9])(\d{1,2})(?: de)? (${MONTH_NAMES})(?:,? (?:de |del )?(\d{4}))?(?![a-z0-9])`,
  'g',
);
/** "en abril", "para abril de 2026", "a fines de abril" (no day). */
const NAMED_MONTH = new RegExp(
  String.raw`(?<![a-z0-9])(?:en|para|a|hasta|durante|finales de|fines de|inicios de|principios de|mediados de|el mes de) (${MONTH_NAMES})(?:,? (?:de |del )?(\d{4}))?(?![a-z0-9])`,
  'g',
);
/** "proximo mes", "la semana que viene": a stated interval. */
const NEXT_PERIOD =
  /(?<![a-z0-9])(?:prox(?:im[oa])?\.? (semana|mes|ano)|(semana|mes|ano) (?:que viene|proxim[oa]|entrante))(?![a-z])/g;
/** "proximo control", "antes de la proxima cita": the next visit, whenever it is. */
const NEXT_VISIT =
  /(?<![a-z0-9])prox(?:im[oa]s?)?\.? (?:control|ctrl|cita|consulta|visita|sesion|evaluacion|valoracion|reevaluacion)(?![a-z])/;
const PERIODIC_DAYS: Readonly<Record<string, number>> = {
  semanal: 7,
  semanalmente: 7,
  quincenal: 15,
  mensual: 30,
  mensualmente: 30,
  bimestral: 60,
  trimestral: 90,
  semestral: 180,
  anual: 365,
  anualmente: 365,
};
const PERIODIC_WORDS = new RegExp(
  String.raw`(?<![a-z])(${Object.keys(PERIODIC_DAYS).join('|')})(?![a-z])`,
  'g',
);

/** What a text says about when something is due, in forms the code can check. */
export interface StatedTiming {
  /** Approximate days from the note date: intervals ("en 3 meses"), "proximo mes", "mensual". */
  readonly days: readonly number[];
  /** Calendar days written in the text, `YYYY-MM-DD` (a missing year is the next such day on or after the note). */
  readonly dates: readonly string[];
  /** Calendar months written without a day ("en abril"), `YYYY-MM`. */
  readonly months: readonly string[];
  /** It points at the next visit ("al proximo control") without saying when. */
  readonly nextVisit: boolean;
  /** It states a target age ("a las 20 semanas") the code cannot turn into days. */
  readonly targetAge: boolean;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A written day with an optional year, as `YYYY-MM-DD`; without a year, the first such day on or after `noteDay`. */
function dayKey(noteDay: string, day: number, month: number, rawYear?: string): string | undefined {
  const noteYear = Number(noteDay.slice(0, 4));
  if (rawYear !== undefined && rawYear !== '') {
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return validDay(year, month, day) ? `${String(year)}-${pad(month)}-${pad(day)}` : undefined;
  }
  for (const year of [noteYear, noteYear + 1]) {
    const key = `${String(year)}-${pad(month)}-${pad(day)}`;
    if (validDay(year, month, day) && key >= noteDay) return key;
  }
  return undefined;
}

/**
 * Reads the timing a text states (normalized text; `noteDay` is the note's
 * `YYYY-MM-DD`). Used to check that a model's due date or interval is the
 * one written where it quotes.
 */
export function statedTiming(text: string, noteDay: string): StatedTiming {
  const days = forwardIntervals(text).map(approxDays);
  for (const match of text.matchAll(NEXT_PERIOD)) {
    const unit = match[1] ?? match[2];
    days.push(unit === 'semana' ? 7 : unit === 'ano' ? 365 : 30);
  }
  for (const match of text.matchAll(PERIODIC_WORDS)) {
    const value = PERIODIC_DAYS[match[1] ?? ''];
    if (value !== undefined) days.push(value);
  }
  const dates: string[] = [];
  for (const match of text.matchAll(NUMERIC_DAY)) {
    const key = dayKey(noteDay, Number(match[1]), Number(match[2]), match[3]);
    if (key) dates.push(key);
  }
  for (const match of text.matchAll(NAMED_DAY)) {
    const month = MONTHS[match[2] ?? ''];
    const key = month ? dayKey(noteDay, Number(match[1]), month, match[3]) : undefined;
    if (key) dates.push(key);
  }
  const months: string[] = [];
  const noteMonth = noteDay.slice(0, 7);
  for (const match of text.matchAll(NAMED_MONTH)) {
    const month = MONTHS[match[1] ?? ''];
    if (month === undefined) continue;
    const year = match[2]
      ? Number(match[2])
      : `${noteDay.slice(0, 4)}-${pad(month)}` >= noteMonth
        ? Number(noteDay.slice(0, 4))
        : Number(noteDay.slice(0, 4)) + 1;
    months.push(`${String(year)}-${pad(month)}`);
  }
  return {
    days,
    dates,
    months,
    nextVisit: NEXT_VISIT.test(text),
    targetAge: TARGET_AGE.test(text),
  };
}

/** Whether `timing` states anything the code can compare with a due date. */
export function isVerifiable(timing: StatedTiming): boolean {
  return timing.days.length > 0 || timing.dates.length > 0 || timing.months.length > 0;
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

/** Every plan word of every kind, normalized (used to tell clinical words from names). */
export function planVocabulary(): Iterable<string> {
  return Object.values(KIND_TERMS).flat();
}

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

/** What follows a conditional "si" ("si no mejora", "si persiste", "si fiebre"). */
const SI_CONDITION = String.raw`si (?:no )?(?:mejora|mejoria|cede|ceden|resuelve|remite|remiten|responde|evoluciona|empeora|empeoran|persiste|persisten|continua|continuan|sigue|siguen|reaparece|reaparecen|recurre|aumenta|aumentan|aparece|aparecen|presenta|presentara|hay|tiene|nota|siente|lo requiere|lo desea|lo amerita|requiere|es necesario|fuese necesario|fuera necesario|fiebre|dolor|sangrado|sintomas|signos|molestias|complicaciones|cambios)`;
const CONDITIONAL = new RegExp(
  String.raw`(?<![a-z])(?:(?:solo|solamente|unicamente) si|${SI_CONDITION}|en caso de|de no (?:mejorar|haber mejoria|ceder|resolver)|ante (?:cualquier|la presencia|la aparicion|signos|sintomas|empeoramiento)|de ser necesario|segun necesidad|segun evolucion|a necesidad|prn|sos|a demanda|libre demanda)(?![a-z])`,
);
/** A clause that opens with its condition ("Si no mejora en 1 semana, reconsultar"). */
const CONDITION_FIRST = new RegExp(
  String.raw`^\s*(?:[a-z]{1,15}\s?:\s*)?(?:y |o |pero )?(?:(?:solo|solamente|unicamente) si|si|en caso de|de no|de persistir|de presentar|de empeorar)(?![a-z])`,
);
const SCHEDULED_ANYWAY = /(?<![a-z])(?:o antes|antes si|antes de ser necesario)(?![a-z])/;

/**
 * Whether a plan phrase only applies on a condition ("ctrl en 1 semana solo
 * si persisten los sintomas", "volver en caso de fiebre", "volver en 1 mes
 * si no mejora"): not a scheduled follow-up. "Control en 1 mes o antes si
 * empeora" is scheduled. `clause`, when given, is the sentence around the
 * segment: a sentence that opens with its condition ("Si no mejora en 1
 * semana, reconsultar") makes every segment of it conditional.
 */
export function isConditional(segment: string, clause?: string): boolean {
  if (SCHEDULED_ANYWAY.test(segment)) return false;
  return CONDITIONAL.test(segment) || (clause !== undefined && CONDITION_FIRST.test(clause));
}

/**
 * Words that cancel a follow-up ("se suspende el control en 1 mes", "el
 * control queda suspendido", "sin control por ahora").
 */
const SUSPENDED =
  /(?<![a-z])(?:se suspende|suspender|suspende|suspendid[oa]s?|se cancela|cancelar|cancelad[oa]s?|se anula|anulad[oa]s?|queda sin efecto|sin (?:control|controles|cita|citas|seguimiento) por (?:ahora|el momento))(?![a-z])/;

/**
 * Whether a plan segment (one list item, see {@link segmentAround}) cancels
 * the follow-up it names. Read per segment, so "se suspende metformina,
 * control en 3 meses" keeps the control.
 */
export function statesSuspension(segment: string): boolean {
  return SUSPENDED.test(segment);
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
const NEGATION_AFTER =
  /^\s*(?:[:(]\s*)?(?:descartad[oa]s?|negativ[oa]s?|negad[oa]s?|neg(?![a-z])|\(-\)|-\s|ausente|no\s*(?:[.,;)]|$))/;
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

const RELATIVE = String.raw`(?:madre|padre|mama|papa|progenitora?|hermanos?|hermanas?|abuelos?|abuelas?|tios?|tias?|primos?|primas?|hijos?|hijas?|sobrinos?|sobrinas?|familiares?|familia)`;
/** A family-history section header ("AHF:", "Antecedentes familiares:"), or the direct form ("antecedentes familiares de HTA"). */
const FAMILY_SECTION =
  /(?<![a-z])(?:antecedentes? (?:heredo)?familiares?|antecedentes? heredofamiliares?|historia familiar|historia clinica familiar|hx familiar|a\.? ?h\.? ?f\.?|ahf)(?![a-z])/g;
const FAMILY_SECTION_EMPTY =
  /^\s*(?:sin importancia|de importancia|no contributorios?|negativos?|negados?|no relevantes?|sin datos)/;
const PERSONAL_SECTION =
  /(?<![a-z])(?:antecedentes? personales?|personales|a\.? ?p\.? ?p\.?|app|paciente|pcte|pte|dx|idx|diagnostico|impresion|motivo de consulta|enfermedad actual|ea)(?![a-z])/g;
const RELATIVE_BEFORE = new RegExp(String.raw`(?<![a-z])${RELATIVE}(?![a-z])`);
const REPORTED_BY =
  /(?<![a-z])(?:refiere|refieren|comenta|comentan|informa|dice|relata|trae|acompana|acude)(?![a-z])/;
const RELATIVE_AFTER = new RegExp(
  String.raw`^\s*(?:\(\s*(?:en (?:la |el |su )?)?${RELATIVE}|(?:en|de) (?:la |el |su |sus |los |las )?${RELATIVE}(?![a-z]))`,
);
const SEGMENT_START = /[,;(\n]|\.(?!\d)|(?<![a-z])(?:y|e|pero)(?![a-z])/g;

function lastMatchIndex(pattern: RegExp, text: string): { index: number; end: number } | undefined {
  let found: { index: number; end: number } | undefined;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    found = { index: match.index, end: match.index + match[0].length };
  }
  pattern.lastIndex = 0;
  return found;
}

/**
 * Whether the mention at `[start, end)` is a relative's disease, not the
 * patient's: under a family-history header ("AHF: diabetes (madre), HTA
 * (padre)"), in the direct form ("antecedentes familiares de HTA"), next to a
 * relative ("madre con DM2", "padre hipertenso", "DM2 (madre)", "HTA en el
 * padre"). A relative who only reports ("la madre refiere que...") does not count.
 */
export function isFamilyHistoryMention(text: string, start: number, end: number): boolean {
  const [clauseStart] = clauseBoundsAround(text, start, end);
  const before = text.slice(clauseStart, start);
  const family = lastMatchIndex(FAMILY_SECTION, before);
  if (family && !FAMILY_SECTION_EMPTY.test(before.slice(family.end))) {
    const personal = lastMatchIndex(PERSONAL_SECTION, before);
    if (personal === undefined || personal.index < family.index) return true;
  }
  const segmentStart = lastMatchIndex(SEGMENT_START, before)?.end ?? 0;
  const segment = before.slice(segmentStart);
  if (RELATIVE_BEFORE.test(segment) && !REPORTED_BY.test(segment)) return true;
  return RELATIVE_AFTER.test(text.slice(end, end + 40));
}

const RISK_BEFORE =
  /(?<![a-z])(?:riesgo (?:alto |elevado |aumentado )?(?:de|para)|alto riesgo de|predisposicion (?:a|para)|propenso a|propensa a|prevencion de|prevenir|tamizaje (?:de|para)|despistaje (?:de|para)|cribado (?:de|para)|screening (?:de|para)|pesquisa de)(?: (?:desarrollar|padecer|presentar|tener))?\s*$/;
const PRE_PREFIX = /(?<![a-z])pre[\s-]?$/;
const GESTATIONAL_AFTER = /^\s*(?:gestacional|del embarazo|en el embarazo)(?![a-z])/;
const PAST_PREGNANCY =
  /(?<![a-z])(?:embarazos? (?:previos?|anteriores?|pasados?)|(?:ultimo|primer|anterior|previo) embarazo|gestacion(?:es)? (?:previas?|anteriores?)|embarazo de su (?:primer|ultimo|anterior)|en (?:su|el) (?:embarazo|parto) (?:anterior|previo))(?![a-z])/;

/** ICD-10 categories that are diabetes proper (not gestational, not prediabetes). */
const DIABETES_CATEGORIES = new Set(['E10', 'E11', 'E13', 'E14']);

/**
 * Why the mention at `[start, end)` is not a current condition of this
 * patient, if it is not: a relative's disease (`family_history`), a risk or
 * screening statement ("riesgo de desarrollar diabetes"), "pre-diabetes"
 * read as diabetes, gestational diabetes read as diabetes, or a past
 * pregnancy read as a current one ("diabetes gestacional en embarazo
 * previo") (`not_current`).
 */
export function conditionContext(
  text: string,
  start: number,
  end: number,
  category: string,
): 'family_history' | 'not_current' | undefined {
  if (isFamilyHistoryMention(text, start, end)) return 'family_history';
  const [clauseStart, clauseEnd] = clauseBoundsAround(text, start, end);
  const before = text.slice(clauseStart, start);
  if (RISK_BEFORE.test(lastTokens(before, 5) + (before.endsWith(' ') ? ' ' : ''))) {
    return 'not_current';
  }
  if (DIABETES_CATEGORIES.has(category)) {
    if (PRE_PREFIX.test(before) || GESTATIONAL_AFTER.test(text.slice(end, end + 24))) {
      return 'not_current';
    }
  }
  if (
    /^(?:O\d|Z3[2-9])/.test(category) &&
    PAST_PREGNANCY.test(text.slice(clauseStart, clauseEnd))
  ) {
    return 'not_current';
  }
  return undefined;
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
  /(?<![a-z])(?:se (?:le )?(?:da|otorga|indica|decide|firma) (?:el )?(?:de )?alta|dad[oa] de alta|doy de alta|damos de alta|alta (?:medica|definitiva|terapeutica|del servicio|por mejoria|de (?:psicologia|psicoterapia|fisioterapia|terapia|consulta|ginecologia|medicina interna|la consulta|la especialidad|la terapia|tratamiento))|egreso del (?:programa|proceso|servicio)|(?:se cierra|cerramos|se concluye|se finaliza|se termina|finaliza|concluye|termina) (?:el )?(?:proceso(?: terapeutico| psicoterapeutico| de psicoterapia)?|seguimiento|tratamiento (?:terapeutico|psicoterapeutico|de psicoterapia))|cierre del proceso(?: terapeutico)?|fin del (?:proceso|tratamiento|seguimiento)(?: terapeutico)?|no (?:requiere|amerita|necesita) (?:mas |nuevos |otros )?(?:controles|seguimiento|consultas|citas)(?: (?:por|en) (?:esta|la) (?:especialidad|consulta|servicio))?|sin necesidad de (?:mas |nuevos )?controles)(?![a-z])/g;
/** "dado de alta del hospital", "alta hospitalaria": a hospital discharge, not the end of follow-up here. */
const HOSPITAL_AFTER =
  /^\s*(?:hospitalari[oa]|hace \d|hace (?:un|una|dos|tres|unos|unas|pocos|varios)(?![a-z])|(?:del?|en el|de la) (?:hospital|clinica|hospitalizacion|emergencia|urgencias?|uci|uti|terapia intensiva|sala|internacion|piso))(?![a-z])/;
const DISCHARGE_CLAUSE = /^(?:plan\s*:?\s*)?alta(?:\s+(?:medica|definitiva|por mejoria))?\s*$/;
const DISCHARGE_NEGATION =
  /(?<![a-z])(?:no|aun no|todavia no|sin|pendiente|se difiere|difiere)\s+(?:se\s+(?:le\s+)?)?$/;

/** Where a discharge statement starts and ends in `text` ("se da de alta"), or `undefined`. */
export function findDischarge(text: string): { start: number; end: number } | undefined {
  DISCHARGE.lastIndex = 0;
  for (let match = DISCHARGE.exec(text); match; match = DISCHARGE.exec(text)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
    if (!DISCHARGE_NEGATION.test(before) && !HOSPITAL_AFTER.test(after)) {
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
