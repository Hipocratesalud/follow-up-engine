import { DEFAULT_CONDITION_TERMS } from './condition-terms.ts';
import { testVocabulary } from './lab-tests.ts';
import { normalizeForMatch, type QuoteIndex } from './quote.ts';
import { planVocabulary } from './signals.ts';

/**
 * Finds the patient's names and identifiers in a note, so they can be masked
 * before it leaves for a model, without erasing the clinical content around
 * them.
 *
 * - Names are matched as tokens of the normalized note (no case, accents,
 *   invisible characters or compatibility forms), at word boundaries. Two or
 *   more name parts next to each other ("Julio César Rangel", "Pérez-Gómez",
 *   "Alta Gracia") are masked as one span. A lone part is masked only when it
 *   is distinctive ("Rangel", "Marcadorapellido"); a part that is also an
 *   everyday or clinical word ("Julio", "Abril", "Alta", "Delgado", "HTA")
 *   is masked alone only when it is capitalized right after a form of
 *   address ("Sra. Alta", "Paciente Julio"), so "se da de alta" and "control
 *   el 15 de julio" reach the model intact.
 * - Identifiers (national ids, record numbers, phones) are matched as whole
 *   numbers however punctuated ("V-15.120.850", "15,120,850", "15120850",
 *   "0412-555-1234" for "+58 412 555 1234"), never as loose digit groups: "TA 120/80" and
 *   "metformina 850 mg" stay. Identifiers with letters and few digits
 *   ("SECMARK-77") and emails are matched as their whole token sequence.
 *
 * Everything is linear in the note length per term.
 */

/** A span of the indexed source text to mask. */
export interface MaskSpan {
  readonly start: number;
  readonly end: number;
}

/** Fewest digits for an identifier to be matched by its digits alone. */
const MIN_ID_DIGITS = 5;
/** Fewest digits for an identifier without "+" to be read as a phone number. */
const MIN_PHONE_DIGITS = 10;
/** Fewest digits of a national phone number once the country code is dropped. */
const MIN_NATIONAL_DIGITS = 7;
/** Shortest name part masked on its own. */
const MIN_DISTINCTIVE_LENGTH = 3;

const NAME_PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'da',
  'do',
  'dos',
  'van',
  'von',
  'der',
  'di',
  'mc',
]);

/** Words after which a capitalized everyday word is a name ("Sra. Alta", "Paciente Julio"). */
const NAME_CONTEXT = new Set([
  'sr',
  'sra',
  'srta',
  'senor',
  'senora',
  'senorita',
  'don',
  'dona',
  'paciente',
  'pcte',
  'pte',
  'nombre',
  'llamado',
  'llamada',
]);

/**
 * Name parts that are also everyday Spanish words: months, weekdays, common
 * adjectives and nouns that are frequent given names or surnames. Masked
 * only inside a full name or right after a form of address.
 */
const EVERYDAY_WORDS = [
  // months and weekdays
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
  // given names that are words
  'alta',
  'amparo',
  'angeles',
  'asuncion',
  'aurora',
  'blanca',
  'caridad',
  'concepcion',
  'consuelo',
  'cruz',
  'dolores',
  'esperanza',
  'estrella',
  'fe',
  'gloria',
  'gracia',
  'inmaculada',
  'luz',
  'mar',
  'mercedes',
  'milagros',
  'nieves',
  'paz',
  'pilar',
  'pura',
  'remedios',
  'reyes',
  'rocio',
  'rosa',
  'rosario',
  'salud',
  'socorro',
  'sol',
  'soledad',
  'trinidad',
  'victoria',
  'vida',
  // surnames that are words
  'alegre',
  'alto',
  'bajo',
  'baja',
  'blanco',
  'bravo',
  'bueno',
  'buena',
  'calvo',
  'campo',
  'campos',
  'cano',
  'castillo',
  'cordero',
  'delgado',
  'delgada',
  'flores',
  'franco',
  'fuentes',
  'grande',
  'guerra',
  'iglesias',
  'leal',
  'leon',
  'lobo',
  'mayor',
  'menor',
  'montes',
  'moreno',
  'nino',
  'nina',
  'pastor',
  'prado',
  'rey',
  'rios',
  'rubio',
  'salvador',
  'santos',
  'santa',
  'sierra',
  'torres',
  'vega',
];

let commonWords: Set<string> | undefined;

/** Everyday and clinical words: a name part that is one is never masked alone without context. */
function isCommonWord(part: string): boolean {
  if (commonWords === undefined) {
    const words = new Set<string>(EVERYDAY_WORDS);
    const add = (phrase: string): void => {
      for (const word of normalizeForMatch(phrase).split(/[^\p{L}\p{N}]+/u)) {
        if (word !== '') words.add(word);
      }
    };
    for (const terms of Object.values(DEFAULT_CONDITION_TERMS)) terms.forEach(add);
    for (const term of planVocabulary()) add(term);
    for (const term of testVocabulary()) add(term);
    commonWords = words;
  }
  return commonWords.has(part);
}

const TOKEN = /[\p{L}\p{N}]+/gu;

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokensOf(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** What the host sent, sorted by how it is matched. */
interface Terms {
  /** Name part -> whether it is distinctive enough to mask alone. */
  readonly nameParts: Map<string, boolean>;
  /** Digit strings an identifier can be written as (with and without country code or trunk 0). */
  readonly numbers: Set<string>;
  /** Whether some identifier is a phone: a written number then matches by its national digits too. */
  readonly phones: boolean;
  /** Token sequences of identifiers with letters ("secmark 77") and emails. */
  readonly sequences: string[][];
}

function classifyTerms(terms: readonly string[]): Terms {
  const nameParts = new Map<string, boolean>();
  const numbers = new Set<string>();
  const sequences: string[][] = [];
  let phones = false;
  for (const term of terms) {
    const normalized = normalizeForMatch(term);
    const tokens = tokensOf(normalized).map((token) => token.text);
    if (tokens.length === 0) continue;
    const digits = normalized.replace(/\D/g, '');
    if (/\d/.test(normalized) || normalized.includes('@')) {
      if (digits.length >= MIN_ID_DIGITS) {
        const phone = /^\s*(?:\+|00)/.test(term) || digits.length >= MIN_PHONE_DIGITS;
        phones ||= phone;
        for (const variant of numberVariants(digits, phone)) numbers.add(variant);
      }
      if (digits.length < MIN_ID_DIGITS || normalized.includes('@')) sequences.push(tokens);
      continue;
    }
    for (const part of tokens) {
      if (part.length < 2 || NAME_PARTICLES.has(part)) continue;
      const distinctive = part.length >= MIN_DISTINCTIVE_LENGTH && !isCommonWord(part);
      nameParts.set(part, (nameParts.get(part) ?? false) || distinctive);
    }
  }
  return { nameParts, numbers, phones, sequences };
}

/**
 * The ways a number can be written: as sent and, for a phone, without a 1 to
 * 3 digit country code and with a national trunk 0 ("+58 412 555 1234" is
 * also written "0412-555-1234" and "412 555 1234").
 */
function numberVariants(digits: string, phone: boolean): string[] {
  const variants = [digits];
  if (!phone) return variants;
  if (digits.startsWith('0') && digits.length - 1 >= MIN_NATIONAL_DIGITS) {
    variants.push(digits.slice(1));
  }
  for (let code = 1; code <= 3; code += 1) {
    const national = digits.slice(code);
    if (national.length < MIN_NATIONAL_DIGITS) break;
    variants.push(national, `0${national}`);
  }
  return variants;
}

/** Separators allowed between the groups of one written number ("15.120.850", "(0412) 555-1234"). */
const NUMBER_GAP = /^[\s.\-/()+]{1,3}$/;
/**
 * A comma joins two groups only as a thousands separator, before exactly
 * three digits ("12,345,678"): "2,5 mg" and "12,5 mcg" are decimals.
 */
const THOUSANDS_COMMA = ',';
const THOUSANDS_GROUP_DIGITS = 3;

function joinsGroups(gap: string, nextDigits: string): boolean {
  return (
    NUMBER_GAP.test(gap) ||
    (gap === THOUSANDS_COMMA && nextDigits.length === THOUSANDS_GROUP_DIGITS)
  );
}
/** Separators allowed between the tokens of one name ("Pérez Gómez", "Pérez-Gómez"). */
const NAME_GAP = /^\s?-?\s?$/;
/** Separators allowed between the tokens of one identifier ("SECMARK-77", "a.b@c.com"). */
const SEQUENCE_GAP = /^[^\p{L}\p{N}]{1,3}$/u;

/** Longest phone number (E.164), in digits. */
const MAX_PHONE_DIGITS = 15;

function numberSpans(normalized: string, terms: Terms): [number, number][] {
  const { numbers, phones } = terms;
  if (numbers.size === 0) return [];
  const groups = [...normalized.matchAll(/\d+/g)].map((match) => ({
    digits: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const isPrefix = (value: string): boolean => {
    for (const number of numbers) if (number.startsWith(value)) return true;
    return false;
  };
  // A phone in the note may carry a country code the host did not send, or
  // lack the one it did: compare national digits both ways.
  const matches = (value: string): boolean =>
    numbers.has(value) ||
    (phones &&
      value.length >= MIN_NATIONAL_DIGITS &&
      numberVariants(value, true).some((variant) => numbers.has(variant)));
  const spans: [number, number][] = [];
  for (let first = 0; first < groups.length; first += 1) {
    let value = '';
    for (let last = first; last < groups.length; last += 1) {
      const group = groups[last];
      const previous = groups[last - 1];
      if (group === undefined) break;
      if (
        last > first &&
        previous &&
        !joinsGroups(normalized.slice(previous.end, group.start), group.digits)
      )
        break;
      value += group.digits;
      const start = groups[first]?.start;
      if (matches(value) && start !== undefined) {
        spans.push([start, group.end]);
        break;
      }
      if (!isPrefix(value) && !(phones && value.length < MAX_PHONE_DIGITS)) break;
    }
  }
  return spans;
}

function sequenceSpans(tokens: readonly Token[], normalized: string, sequences: string[][]) {
  const spans: [number, number][] = [];
  for (const sequence of sequences) {
    const joined = sequence.join('');
    for (let i = 0; i < tokens.length; i += 1) {
      const first = tokens[i];
      if (first === undefined) continue;
      if (first.text === joined) {
        spans.push([first.start, first.end]);
        continue;
      }
      let matched = 0;
      while (matched < sequence.length) {
        const token = tokens[i + matched];
        const previous = tokens[i + matched - 1];
        if (token === undefined || token.text !== sequence[matched]) break;
        if (
          matched > 0 &&
          previous &&
          !SEQUENCE_GAP.test(normalized.slice(previous.end, token.start))
        )
          break;
        matched += 1;
      }
      const last = tokens[i + matched - 1];
      if (matched === sequence.length && last) spans.push([first.start, last.end]);
    }
  }
  return spans;
}

function nameSpans(index: QuoteIndex, tokens: readonly Token[], parts: Map<string, boolean>) {
  const normalized = index.normalized.text;
  const spans: [number, number][] = [];
  if (parts.size === 0) return spans;
  const isCapitalized = (token: Token): boolean =>
    /^\p{Lu}/u.test(index.spanOf(token.start, token.end)?.text ?? '');
  const afterAddress = (at: number): boolean => {
    const previous = tokens[at - 1];
    const token = tokens[at];
    return (
      previous !== undefined &&
      token !== undefined &&
      NAME_CONTEXT.has(previous.text) &&
      /^[\s.:,]{0,3}$/.test(normalized.slice(previous.end, token.start))
    );
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || !(parts.has(token.text) || NAME_PARTICLES.has(token.text))) {
      i += 1;
      continue;
    }
    // A run of name parts and particles joined by a space or a hyphen.
    let end = i;
    while (end + 1 < tokens.length) {
      const next = tokens[end + 1];
      const current = tokens[end];
      if (next === undefined || current === undefined) break;
      if (!(parts.has(next.text) || NAME_PARTICLES.has(next.text))) break;
      if (!NAME_GAP.test(normalized.slice(current.end, next.start))) break;
      end += 1;
    }
    const names: number[] = [];
    for (let at = i; at <= end; at += 1) {
      const text = tokens[at]?.text ?? '';
      if (parts.has(text)) names.push(at);
    }
    const firstName = names[0];
    const lastName = names.at(-1);
    if (names.length >= 2 && firstName !== undefined && lastName !== undefined) {
      const from = tokens[firstName];
      const to = tokens[lastName];
      if (from && to) spans.push([from.start, to.end]);
    } else if (firstName !== undefined) {
      const only = tokens[firstName];
      const distinctive = only ? parts.get(only.text) === true : false;
      if (only && (distinctive || (isCapitalized(only) && afterAddress(firstName)))) {
        spans.push([only.start, only.end]);
      }
    }
    i = end + 1;
  }
  return spans;
}

/** Where the patient's names and identifiers (`terms`) appear in the indexed text. */
export function findPatientMentions(index: QuoteIndex, terms: readonly string[]): MaskSpan[] {
  const classified = classifyTerms(terms.filter((term) => term.trim() !== ''));
  const normalized = index.normalized.text;
  const tokens = tokensOf(normalized);
  const spans = [
    ...nameSpans(index, tokens, classified.nameParts),
    ...numberSpans(normalized, classified),
    ...sequenceSpans(tokens, normalized, classified.sequences),
  ];
  return spans.flatMap(([start, end]) => {
    const span = index.spanOf(start, end);
    return span ? [{ start: span.start, end: span.end }] : [];
  });
}

/**
 * Delimiter-shaped tags in any disguise, on the normalized text (fullwidth
 * brackets folded, zero-width characters dropped, Cyrillic look-alikes
 * folded): an opening bracket, raw or as an HTML entity, then "clinical" or
 * "note", through the closing bracket if one follows within the tag
 * ("</clinical_note foo=\"1\">", "&lt;/clinical_note&gt;", "</clinical_note").
 */
const OPEN = String.raw`(?:<|&lt;?|&#0*60;?|&#x0*3c;?)`;
const SLASH = String.raw`(?:\/|&#0*47;?|&#x0*2f;?|&sol;)`;
const CLOSE = String.raw`(?:>|&gt;?|&#0*62;?|&#x0*3e;?)`;
const DELIMITER = new RegExp(
  String.raw`${OPEN}\s?${SLASH}?\s?(?:clinical|note)(?:[^<>&]{0,80}?${CLOSE}|[\p{L}\p{N}_\-]*)`,
  'gu',
);

/** Where delimiter-shaped tags appear in the indexed text. */
export function findDelimiterTags(index: QuoteIndex): MaskSpan[] {
  const spans: MaskSpan[] = [];
  for (const match of index.normalized.text.matchAll(DELIMITER)) {
    const span = index.spanOf(match.index, match.index + match[0].length);
    if (span) spans.push({ start: span.start, end: span.end });
  }
  return spans;
}
