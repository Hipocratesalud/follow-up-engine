/**
 * Evidence-quote verification. A model may paraphrase, fix typos or invent
 * text; the engine only accepts items whose quote really appears in the
 * note. Matching ignores case, accents, curly vs straight quotes and
 * whitespace runs (doctors write "Plan:  ctrl" and models echo "plan: ctrl"),
 * and returns the span exactly as written in the note.
 */

const QUOTE_EDGES = /^[\s"'“”‘’«»`]+|[\s"'“”‘’«»`]+$/g;

function normalizeChar(char: string): string {
  return char
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’`]/g, "'");
}

interface NormalizedText {
  readonly text: string;
  /** For each normalized character, the [start, end) range in the source string. */
  readonly spans: readonly (readonly [number, number])[];
}

function normalizeWithSpans(source: string): NormalizedText {
  let text = '';
  const spans: [number, number][] = [];
  let index = 0;
  for (const char of source) {
    const start = index;
    index += char.length;
    if (/\s/u.test(char)) {
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' ';
        spans.push([start, index]);
      }
      continue;
    }
    for (const normalized of normalizeChar(char)) {
      text += normalized;
      spans.push([start, index]);
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    spans.pop();
  }
  return { text, spans };
}

/** The comparison form of a string: lowercase, no accents, single spaces. */
export function normalizeForMatch(value: string): string {
  return normalizeWithSpans(value).text;
}

/**
 * Maps the range `[start, end)` of `normalizeForMatch(source)` back to the
 * verbatim text of `source`.
 */
export function originalSpan(source: string, start: number, end: number): string {
  const { spans } = normalizeWithSpans(source);
  const first = spans[start];
  const last = spans[Math.max(start, end - 1)];
  if (!first || !last) return '';
  return source.slice(first[0], last[1]);
}

/**
 * Finds `quote` in `note` (normalized comparison) and returns the matching
 * span verbatim from the note, or `undefined` when it is not there.
 */
export function locateQuote(note: string, quote: string): string | undefined {
  const needle = normalizeForMatch(quote.replace(QUOTE_EDGES, ''));
  if (needle.length === 0) return undefined;
  const haystack = normalizeWithSpans(note);
  const at = haystack.text.indexOf(needle);
  if (at < 0) return undefined;
  const first = haystack.spans[at];
  const last = haystack.spans[at + needle.length - 1];
  if (!first || !last) return undefined;
  return note.slice(first[0], last[1]);
}
