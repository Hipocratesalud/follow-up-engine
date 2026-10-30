import { TEST_GROUPS } from '../terminology/test-names.ts';
import { fold } from './confirmation.ts';

/**
 * What an outbound message to a patient must never contain
 * (docs/agent/order-to-completion.md#what-a-patient-message-may-say),
 * checked by code on every message before it is sent, whatever the model
 * wrote, on the whole text the patient would receive (the model's words
 * and the slot list code appends):
 *
 * - `result_value`: a measured value (a decimal, a number with a unit or %,
 *   a value spelled out: "ocho coma cuatro", "eight point four");
 * - `result_judgement`: a verdict on a result, good or bad ("high",
 *   "elevado", "normal", "salió bien", "worse", "preocupante");
 * - `condition_term`: the name of a condition or diagnosis (the clinic's
 *   condition lexicon, injected: `@follow-up-engine/llm` builds it from the
 *   extraction's term tables), or an everyday word that stands for one
 *   ("el azúcar", "la presión", "your sugar");
 * - `test_name`: the name of a specific test or study (HbA1c, PSA, HIV
 *   test, Pap smear, mammogram; every term of the lab-test lexicon
 *   `TEST_GROUPS`). A test's name tells whoever reads the phone what it
 *   monitors, so a patient message only uses a generic category: "el
 *   examen de laboratorio", "your lab test", "un estudio de imagen";
 * - `diagnosis_word`: the words "diagnosis" / "diagnóstico" themselves;
 * - `medical_advice`: dosing or treatment instructions.
 *
 * A message with any violation is refused and the model must rewrite it.
 */
export const OUTBOUND_VIOLATION_KINDS = [
  'result_value',
  'result_judgement',
  'condition_term',
  'test_name',
  'diagnosis_word',
  'medical_advice',
] as const;
export type OutboundViolationKind = (typeof OUTBOUND_VIOLATION_KINDS)[number];

export interface OutboundViolation {
  readonly kind: OutboundViolationKind;
  readonly match: string;
}

export interface OutboundSafetyTerms {
  /** Condition names, any language, as written in notes (folded and matched as whole words here). */
  readonly conditionTerms: readonly string[];
}

const UNIT_VALUE =
  /\b\d+(?:[.,]\d+)?\s?(?:%|mg\/dl|mg\/dL|mmol\/l|mmol|g\/dl|g\/l|mg|mcg|ui|u\/l|meq\/l|mmhg|mm hg|ng\/ml|pg\/ml|kg\/m2)(?![a-z])/giu;
/** A decimal number that is not a clock time (09:30) or a date (6/11). */
const DECIMAL = /(?<![\d/]|\d:)\d+[.,]\d+(?![\d/]|:\d)/gu;
/** A number with "por ciento" / "percent" written out. */
const PERCENT_WORDS = /\b\d+(?:[.,]\d+)?\s?(?:por ciento|percent|per cent)\b/giu;

/** Number words (folded) that make a spelled-out value with "coma", "punto", "point" or "por ciento". */
const NUMBER_WORDS = [
  'cero',
  'uno',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'cien',
  'ciento',
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'hundred',
];
const SPELLED_VALUE = new RegExp(
  ` (${NUMBER_WORDS.join('|')}) (?:(?:coma|punto|point) (?:${NUMBER_WORDS.join('|')}|\\d+)|por ciento|percent|per cent) `,
  'u',
);

const JUDGEMENT_PHRASES = [
  'alto',
  'alta',
  'altos',
  'altas',
  'elevado',
  'elevada',
  'elevados',
  'elevadas',
  'anormal',
  'anormales',
  'alterado',
  'alterada',
  'alterados',
  'normal',
  'normales',
  'fuera de rango',
  'fuera del rango',
  'dentro de rango',
  'dentro del rango',
  'en rango',
  'descontrolado',
  'descontrolada',
  'mal controlado',
  'mal controlada',
  'empeoro',
  'empeorado',
  'empeorando',
  'peor',
  'mejoro',
  'salio alto',
  'salio alta',
  'salio bajo',
  'salio baja',
  'salio bien',
  'salio mal',
  'salieron bien',
  'salieron mal',
  'no salio bien',
  'no salieron bien',
  'esta alto',
  'esta alta',
  'esta bajo',
  'esta baja',
  'preocupante',
  'preocupantes',
  'alarmante',
  'buenas noticias',
  'malas noticias',
  'high',
  'too high',
  'too low',
  'elevated',
  'abnormal',
  'out of range',
  'within range',
  'in range',
  'uncontrolled',
  'poorly controlled',
  'worse',
  'worsened',
  'worsening',
  'improved',
  'concerning',
  'worrying',
  'alarming',
  'not good',
  'good news',
  'bad news',
];

const DIAGNOSIS_WORDS = [
  'diagnostico',
  'diagnosticado',
  'diagnosticada',
  'diagnosis',
  'diagnosed',
  'diagnose',
];

const ADVICE_PHRASES = [
  'dosis',
  'dose',
  'dosage',
  'deja de tomar',
  'deje de tomar',
  'suspende',
  'suspenda',
  'aumenta la',
  'aumente la',
  'stop taking',
  'increase your',
  'reduce your',
];

/**
 * Everyday words that stand for a condition or the organ a test watches
 * ("el azúcar" is diabetes in Latin American Spanish): never in a message.
 */
const CONDITION_HINTS = [
  'azucar',
  'sugar',
  'presion',
  'presion arterial',
  'tension arterial',
  'blood pressure',
  'tiroides',
  'thyroid',
  'colesterol',
  'cholesterol',
  'trigliceridos',
  'triglycerides',
  'rinon',
  'rinones',
  'kidney',
  'kidneys',
  'higado',
  'prostata',
  'prostate',
  'embarazo',
  'embarazada',
  'pregnancy',
  'pregnant',
  'cancer',
  'tumor',
];

/**
 * Terms of the test lexicon that are everyday words or chat shorthand in a
 * message ("k" is "que", "echo" is a verb in Spanish, "placa" a plate): not
 * test names for this check. The full name of each test stays blocked.
 */
const EVERYDAY_TEST_TERMS: ReadonlySet<string> = new Set([
  'k',
  'k ',
  'na',
  'tp',
  'ua',
  'u a',
  'alt',
  'ego',
  'echo',
  'placa',
  'iron',
  'sono',
]);

/** Every specific test or study name of the lexicon, folded (`TEST_GROUPS` terms and labels). */
export const OUTBOUND_TEST_NAMES: readonly string[] = [
  ...new Set(
    TEST_GROUPS.flatMap((group) => [group.label, ...group.terms])
      .map((term) => fold(term).trim())
      .filter((term) => term.length >= 2 && !EVERYDAY_TEST_TERMS.has(term)),
  ),
];

/**
 * `fold` keeps colons for clock times ("9:30"); here a colon that is not
 * inside a time separates words ("HbA1c: 8,4"), so a term before it still
 * matches as a whole word.
 */
function foldForCheck(text: string): string {
  return fold(text)
    .replace(/(?<!\d):|:(?!\d)/g, ' ')
    .replace(/\s+/g, ' ');
}

function phraseHits(
  folded: string,
  phrases: readonly string[],
  kind: OutboundViolationKind,
): OutboundViolation[] {
  return phrases
    .filter((phrase) => {
      const target = fold(phrase).trim();
      return target !== '' && folded.includes(` ${target} `);
    })
    .map((phrase) => ({ kind, match: phrase }));
}

/** Every violation in a message the model wants to send (empty: safe to send). */
export function checkOutboundText(
  text: string,
  terms: OutboundSafetyTerms,
): readonly OutboundViolation[] {
  const violations: OutboundViolation[] = [];
  for (const match of text.matchAll(UNIT_VALUE)) {
    violations.push({ kind: 'result_value', match: match[0] });
  }
  for (const match of text.matchAll(PERCENT_WORDS)) {
    violations.push({ kind: 'result_value', match: match[0] });
  }
  for (const match of text.matchAll(DECIMAL)) {
    if (!violations.some((item) => item.match.includes(match[0]))) {
      violations.push({ kind: 'result_value', match: match[0] });
    }
  }
  const folded = foldForCheck(text);
  const spelled = SPELLED_VALUE.exec(folded);
  if (spelled !== null) violations.push({ kind: 'result_value', match: spelled[0].trim() });
  violations.push(
    ...phraseHits(folded, JUDGEMENT_PHRASES, 'result_judgement'),
    ...phraseHits(folded, DIAGNOSIS_WORDS, 'diagnosis_word'),
    ...phraseHits(folded, ADVICE_PHRASES, 'medical_advice'),
    ...phraseHits(folded, terms.conditionTerms, 'condition_term'),
    ...phraseHits(folded, CONDITION_HINTS, 'condition_term'),
    ...phraseHits(folded, OUTBOUND_TEST_NAMES, 'test_name'),
  );
  const seen = new Set<string>();
  return violations.filter((item) => {
    const key = `${item.kind}:${item.match.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
