/**
 * Evidence-quote verification. A model may paraphrase, fix typos or invent
 * text; the engine only accepts items whose quote really appears in the
 * note. Matching ignores case, accents, curly vs straight quotes and
 * whitespace runs (doctors write "Plan:  ctrl" and models echo "plan: ctrl"),
 * and returns the span exactly as written in the note.
 *
 * Every function here is linear in the note length: the normalized text is
 * built once into an array and joined, and its map back to the note has one
 * entry per UTF-16 code unit of the normalized text, so emoji and other
 * astral characters (two code units) never shift a span.
 */

const QUOTE_EDGES = /^[\s"'“”‘’«»`]+|[\s"'“”‘’«»`]+$/g;
const WHITESPACE = /\s/u;
const MARKS = /\p{M}/gu;

const normalizedChars = new Map<string, string>();

/** Lowercase, no combining marks, straight quotes. Memoized per code point. */
function normalizeChar(char: string): string {
  const cached = normalizedChars.get(char);
  if (cached !== undefined) return cached;
  const normalized = char
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’`]/g, "'");
  if (normalizedChars.size < 10_000) normalizedChars.set(char, normalized);
  return normalized;
}

/** A note in comparison form, with the way back to the original text. */
export interface NormalizedText {
  /** Lowercase, no accents, whitespace runs collapsed to one space, trimmed. */
  readonly text: string;
  /**
   * For each UTF-16 code unit of `text`, the start and end (exclusive) of
   * the source code point(s) it came from, as UTF-16 indices into the source.
   */
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
}

/** Normalizes `source` once, keeping a per-code-unit map back to it. Linear time. */
export function normalizeWithSpans(source: string): NormalizedText {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace: [number, number] | undefined;
  let index = 0;
  for (const char of source) {
    const start = index;
    index += char.length;
    if (WHITESPACE.test(char)) {
      // Collapse a run into one space, emitted only if text follows it.
      if (parts.length > 0) pendingSpace ??= [start, index];
      continue;
    }
    const normalized = normalizeChar(char);
    if (normalized.length === 0) continue;
    if (pendingSpace) {
      parts.push(' ');
      starts.push(pendingSpace[0]);
      ends.push(pendingSpace[1]);
      pendingSpace = undefined;
    }
    parts.push(normalized);
    for (let units = normalized.length; units > 0; units -= 1) {
      starts.push(start);
      ends.push(index);
    }
  }
  return { text: parts.join(''), starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}

/** The comparison form of a string: lowercase, no accents, single spaces. */
export function normalizeForMatch(value: string): string {
  return normalizeWithSpans(value).text;
}

/** A located quote: the verbatim note text and its UTF-16 range in the note. */
export interface QuoteSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The same quote's range in the normalized text. */
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
}

/**
 * A note prepared for many quote lookups: normalized once, then each lookup
 * is one `indexOf` over the normalized text.
 */
export interface QuoteIndex {
  readonly source: string;
  readonly normalized: NormalizedText;
  /** Finds `quote` (normalized comparison) and returns its verbatim span, or `undefined`. */
  locate(quote: string): QuoteSpan | undefined;
  /** Maps `[start, end)` of the normalized text to the verbatim source span. */
  spanOf(start: number, end: number): QuoteSpan | undefined;
}

export function createQuoteIndex(source: string): QuoteIndex {
  const normalized = normalizeWithSpans(source);
  const spanOf = (start: number, end: number): QuoteSpan | undefined => {
    if (start < 0 || end <= start || end > normalized.text.length) return undefined;
    const from = normalized.starts[start];
    const to = normalized.ends[end - 1];
    if (from === undefined || to === undefined) return undefined;
    return {
      text: source.slice(from, to),
      start: from,
      end: to,
      normalizedStart: start,
      normalizedEnd: end,
    };
  };
  return {
    source,
    normalized,
    spanOf,
    locate(quote) {
      const needle = normalizeForMatch(quote.replace(QUOTE_EDGES, ''));
      if (needle.length === 0) return undefined;
      const at = normalized.text.indexOf(needle);
      return at < 0 ? undefined : spanOf(at, at + needle.length);
    },
  };
}

/**
 * Maps the range `[start, end)` of `normalizeForMatch(source)` back to the
 * verbatim text of `source`. Builds an index per call: for many lookups on
 * the same note use {@link createQuoteIndex}.
 */
export function originalSpan(source: string, start: number, end: number): string {
  return createQuoteIndex(source).spanOf(start, Math.max(start + 1, end))?.text ?? '';
}

/**
 * Finds `quote` in `note` (normalized comparison) and returns the matching
 * span verbatim from the note, or `undefined` when it is not there.
 */
export function locateQuote(note: string, quote: string): string | undefined {
  return createQuoteIndex(note).locate(quote)?.text;
}
