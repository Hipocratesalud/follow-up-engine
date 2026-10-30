import { fold } from './confirmation.ts';

/**
 * What an outbound message to a patient must never contain
 * (docs/agent/order-to-completion.md#guardrails), checked by code on every
 * message before it is sent, whatever the model wrote:
 *
 * - `result_value`: a measured value (a decimal, a number with a unit or %);
 * - `result_judgement`: a verdict on a result ("high", "elevado", "abnormal");
 * - `condition_term`: the name of a condition or diagnosis (the clinic's
 *   condition lexicon, injected: `@follow-up-engine/llm` builds it from the
 *   extraction's term tables);
 * - `diagnosis_word`: the words "diagnosis" / "diagnóstico" themselves;
 * - `medical_advice`: dosing or treatment instructions.
 *
 * A message with any violation is refused and the model must rewrite it.
 */
export const OUTBOUND_VIOLATION_KINDS = [
  'result_value',
  'result_judgement',
  'condition_term',
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
const DECIMAL = /(?<![\d:/])\d+[.,]\d+(?![\d:/])/gu;

const JUDGEMENT_PHRASES = [
  'elevado',
  'elevada',
  'elevados',
  'elevadas',
  'anormal',
  'anormales',
  'alterado',
  'alterada',
  'alterados',
  'fuera de rango',
  'fuera del rango',
  'descontrolado',
  'descontrolada',
  'mal controlado',
  'mal controlada',
  'empeoro',
  'empeorado',
  'salio alto',
  'salio alta',
  'salio bajo',
  'salio baja',
  'salio bien',
  'salio mal',
  'esta alto',
  'esta alta',
  'esta bajo',
  'esta baja',
  'high',
  'too high',
  'too low',
  'elevated',
  'abnormal',
  'out of range',
  'uncontrolled',
  'poorly controlled',
  'worse',
  'worsened',
  'worsening',
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
  for (const match of text.matchAll(DECIMAL)) {
    if (!violations.some((item) => item.match.includes(match[0]))) {
      violations.push({ kind: 'result_value', match: match[0] });
    }
  }
  const folded = fold(text);
  violations.push(
    ...phraseHits(folded, JUDGEMENT_PHRASES, 'result_judgement'),
    ...phraseHits(folded, DIAGNOSIS_WORDS, 'diagnosis_word'),
    ...phraseHits(folded, ADVICE_PHRASES, 'medical_advice'),
    ...phraseHits(folded, terms.conditionTerms, 'condition_term'),
  );
  const seen = new Set<string>();
  return violations.filter((item) => {
    const key = `${item.kind}:${item.match.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
