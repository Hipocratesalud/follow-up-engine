/**
 * Text helpers for the reviewer's detectors and citation checks. Matching is
 * done on a folded copy of the note (lowercase, no accents) while every
 * quote handed out is a verbatim slice of the original, so a detector can
 * never produce a citation that is not in the document.
 */

export interface FoldedText {
  readonly original: string;
  readonly folded: string;
  /** `starts[i]`: index in `original` of the character folded into `folded[i]`. */
  readonly starts: readonly number[];
}

function foldChar(char: string): string {
  return char
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Folds `text` keeping a map from every folded position back to the original. */
export function foldWithMap(text: string): FoldedText {
  let folded = '';
  const starts: number[] = [];
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    for (const piece of foldChar(char)) {
      folded += piece;
      // Every UTF-16 unit of the folded piece maps back to the original character.
      starts.push(...new Array<number>(piece.length).fill(index));
    }
    index += char.length;
  }
  return { original: text, folded, starts };
}

/** The original span behind folded positions `[start, end)`. */
export function originalSlice(text: FoldedText, start: number, end: number): string {
  const from = text.starts[start] ?? text.original.length;
  const lastStart = text.starts[end - 1];
  if (lastStart === undefined) return text.original.slice(from);
  const lastChar = String.fromCodePoint(text.original.codePointAt(lastStart) ?? 0);
  return text.original.slice(from, lastStart + lastChar.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Folded positions where one of `terms` (already folded) starts as a whole word. */
export function findTerms(
  text: FoldedText,
  terms: readonly string[],
): { start: number; end: number; term: string }[] {
  const hits: { start: number; end: number; term: string }[] = [];
  for (const term of terms) {
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${escapeRegExp(term)})(?=$|[^\\p{L}\\p{N}])`,
      'gu',
    );
    for (const match of text.folded.matchAll(pattern)) {
      const start = match.index + (match[1]?.length ?? 0);
      hits.push({ start, end: start + term.length, term });
    }
  }
  return hits.sort((left, right) => left.start - right.start);
}

/** Whether the folded text contains one of the folded phrases anywhere. */
export function mentionsAny(folded: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => folded.includes(phrase));
}

const SENTENCE_BREAK = /[.;!?\n]/;
const MAX_SENTENCE = 180;

/**
 * The sentence (or list item) around folded positions `[start, end)`, as
 * folded bounds: from the previous `.`, `;`, `!`, `?` or line break to the
 * next one, at most {@link MAX_SENTENCE} characters each way.
 */
export function sentenceBounds(
  text: FoldedText,
  start: number,
  end: number,
): { start: number; end: number } {
  let from = start;
  while (
    from > 0 &&
    start - from < MAX_SENTENCE &&
    !SENTENCE_BREAK.test(text.folded[from - 1] ?? '')
  ) {
    from -= 1;
  }
  let to = end;
  while (
    to < text.folded.length &&
    to - end < MAX_SENTENCE &&
    !SENTENCE_BREAK.test(text.folded[to] ?? '')
  ) {
    to += 1;
  }
  while (from < to && /\s|[-•*:,]/.test(text.folded[from] ?? '')) from += 1;
  while (to > from && /\s/.test(text.folded[to - 1] ?? '')) to -= 1;
  return { start: from, end: to };
}

/** The verbatim sentence of the original text around a folded match. */
export function sentenceAround(text: FoldedText, start: number, end: number): string {
  const bounds = sentenceBounds(text, start, end);
  return originalSlice(text, bounds.start, bounds.end);
}

/** The first sentence of a text, verbatim, at most `limit` characters (cut at a word). */
export function firstSentence(text: string, limit = 140): string {
  const trimmed = text.trimStart();
  const offset = text.length - trimmed.length;
  const breakAt = trimmed.search(SENTENCE_BREAK);
  let sentence = breakAt < 0 ? trimmed : trimmed.slice(0, breakAt);
  if (sentence.length > limit) {
    sentence = sentence.slice(0, limit).replace(/\s+\S*$/, '');
  }
  return text.slice(offset, offset + sentence.trimEnd().length);
}

/**
 * Whether a match is denied: one of `negations` (folded, whole words) in the
 * same sentence, within the few words before it ("niega cefalea", "sin
 * disnea ni dolor torácico", "no refiere mareos").
 */
export function isNegated(
  text: FoldedText,
  start: number,
  negations: readonly string[],
  window = 40,
): boolean {
  const sentence = sentenceBounds(text, start, start);
  const before = text.folded.slice(Math.max(sentence.start, start - window), start);
  return negations.some((negation) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(negation)}([^\\p{L}\\p{N}]|$)`, 'u').test(before),
  );
}

/** Collapses whitespace runs, for quote matching that tolerates re-flowed text. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Finds `quote` in `document` verbatim, tolerating only differences in
 * whitespace (a model may re-flow a line break into a space). Returns the
 * exact span of the document, or `undefined`.
 */
export function locateVerbatim(document: string, quote: string): string | undefined {
  const wanted = collapseWhitespace(quote);
  if (wanted === '') return undefined;
  const direct = document.indexOf(quote.trim());
  if (direct >= 0) return document.slice(direct, direct + quote.trim().length);
  const pattern = wanted
    .split(' ')
    .map((word) => escapeRegExp(word))
    .join('\\s+');
  const match = new RegExp(pattern, 'u').exec(document);
  return match?.[0];
}
