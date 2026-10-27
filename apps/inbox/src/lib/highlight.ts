export interface QuoteMatch {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/**
 * Locates the model's verbatim quote inside a note excerpt so the UI can mark
 * it. Exact match first; then a whitespace- and case-insensitive match,
 * because excerpts may be re-flowed. Returns `undefined` when the quote is not
 * in the excerpt, so the caller can show the quote on its own.
 */
export function findQuote(text: string, quote: string): QuoteMatch | undefined {
  const needle = quote.trim();
  if (!needle) return undefined;

  const exact = text.indexOf(needle);
  if (exact >= 0) {
    return {
      before: text.slice(0, exact),
      match: text.slice(exact, exact + needle.length),
      after: text.slice(exact + needle.length),
    };
  }

  const escaped = needle
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const loose = new RegExp(escaped, 'i').exec(text);
  if (!loose) return undefined;
  return {
    before: text.slice(0, loose.index),
    match: loose[0],
    after: text.slice(loose.index + loose[0].length),
  };
}

export interface Segment {
  readonly text: string;
  /** Index into the `quotes` array this segment quotes, if any. */
  readonly quoteIndex?: number;
}

/**
 * Splits `text` into plain and quoted segments for several quotes at once
 * (the demo shows every quote the model cited in the same note). Overlapping
 * quotes keep the earliest one.
 */
export function segmentByQuotes(text: string, quotes: readonly string[]): Segment[] {
  const ranges: { start: number; end: number; quoteIndex: number }[] = [];
  quotes.forEach((quote, quoteIndex) => {
    const found = findQuote(text, quote);
    if (!found) return;
    const start = found.before.length;
    ranges.push({ start, end: start + found.match.length, quoteIndex });
  });
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) });
    segments.push({ text: text.slice(range.start, range.end), quoteIndex: range.quoteIndex });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
