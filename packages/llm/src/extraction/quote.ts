/**
 * Evidence-quote verification. A model may paraphrase, fix typos or invent
 * text; the engine only accepts items whose quote really appears in the
 * note. Matching ignores case, accents, curly vs straight quotes,
 * fullwidth and other compatibility forms, invisible format characters
 * (soft hyphens and zero-width spaces left by copy-paste) and whitespace
 * runs (doctors write "Plan:  ctrl" and models echo "plan: ctrl"), and
 * returns the span exactly as written in the note.
 *
 * Every function here is linear in the note length: the normalized text is
 * built once into an array and joined, and its map back to the note has one
 * entry per UTF-16 code unit of the normalized text, so emoji and other
 * astral characters (two code units) never shift a span.
 */

const QUOTE_EDGES = /^[\s"'“”‘’«»`]+|[\s"'“”‘’«»`]+$/g;
const WHITESPACE = /\s/u;
const MARKS = /\p{M}/gu;
/** Invisible format characters (soft hyphen, zero-width space and joiners, BOM): dropped. */
const FORMAT = /\p{Cf}/gu;

/**
 * Cyrillic and Greek letters that look like Latin ones ("nоte" with a
 * Cyrillic "о"), folded so a look-alike spelling neither hides a patient
 * name nor a prompt delimiter.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

const normalizedChars = new Map<string, string>();

/**
 * Lowercase, compatibility-folded (fullwidth "＜" is "<", "²" is "2"), no
 * combining marks, no invisible format characters, Latin look-alikes
 * folded, straight quotes. Memoized per code point.
 */
function normalizeChar(char: string): string {
  const cached = normalizedChars.get(char);
  if (cached !== undefined) return cached;
  const normalized = Array.from(
    char.normalize('NFKD').replace(MARKS, '').replace(FORMAT, '').toLowerCase(),
    (c) => CONFUSABLES[c] ?? c,
  )
    .join('')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’`]/g, "'");
  if (normalizedChars.size < 10_000) normalizedChars.set(char, normalized);
  return normalized;
}

/** A note in comparison form, with the way back to the original text. */
export interface NormalizedText {
  /**
   * Lowercase, no accents, compatibility-folded, no invisible format
   * characters, whitespace runs collapsed to one space, trimmed.
   */
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
  /** Every occurrence of `quote` (normalized comparison, non-overlapping), first to last. */
  locateAll(quote: string): QuoteSpan[];
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
    locateAll(quote) {
      const needle = normalizeForMatch(quote.replace(QUOTE_EDGES, ''));
      const spans: QuoteSpan[] = [];
      if (needle.length === 0) return spans;
      for (
        let at = normalized.text.indexOf(needle);
        at >= 0;
        at = normalized.text.indexOf(needle, at + needle.length)
      ) {
        const span = spanOf(at, at + needle.length);
        if (span) spans.push(span);
      }
      return spans;
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
