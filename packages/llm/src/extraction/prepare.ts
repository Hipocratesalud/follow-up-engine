import { findDelimiterTags, findPatientMentions, type MaskSpan } from './masking.ts';
import { createQuoteIndex } from './quote.ts';

/**
 * What leaves for a third-party model is the note, minus what the engine can
 * mask: the patient's names and identifiers (the host sends them in the same
 * Bundle, see `NoteExtractionInput.redactTerms`), anything shaped like one of
 * the prompt's own delimiters, and, for a note longer than
 * {@link MAX_NOTE_CHARS}, its middle (the head and the tail are kept, since
 * the plan is usually at the end).
 *
 * The prepared text keeps a map back to the original, so evidence quotes the
 * model copies from the prepared text are stored verbatim from the original
 * note.
 */

/** Longest note (UTF-16 code units) sent to a model; past it, the middle is cut and reported. */
export const MAX_NOTE_CHARS = 20_000;
/** Share of {@link MAX_NOTE_CHARS} kept from the start of a long note; the rest comes from its end. */
export const NOTE_HEAD_SHARE = 0.4;

/** What a masked name or identifier becomes in the prompt. */
export const REDACTION_PLACEHOLDER = '[REDACTADO]';
/** What a delimiter-shaped tag inside host text becomes. */
export const DEFANGED_TAG = '[etiqueta]';
/** What replaces the middle of a note longer than the cap. */
export const ELISION_MARKER = '\n[... parte central de la nota omitida por longitud ...]\n';

/** How far a cut may move to land on whitespace instead of inside a word. */
const CUT_SLACK = 200;

export interface PreparedNote {
  /** The text the model sees. */
  readonly text: string;
  /** The note as the host sent it. */
  readonly original: string;
  /** Whether the note was longer than the cap and its middle was cut. */
  readonly truncated: boolean;
  /** How many spans were masked (names, identifiers). */
  readonly redactions: number;
  /** How many delimiter-shaped tags were neutralized. */
  readonly defanged: number;
  /** Maps the UTF-16 range `[start, end)` of `text` to the range of `original` it came from. */
  toOriginal(start: number, end: number): { readonly start: number; readonly end: number };
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const PRIORITY: Readonly<Record<string, number>> = {
  [ELISION_MARKER]: 3,
  [REDACTION_PLACEHOLDER]: 2,
  [DEFANGED_TAG]: 1,
};

/** Overlapping or touching edits become one (elision over placeholder over tag). */
function mergeEdits(edits: readonly Edit[]): Edit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Edit[] = [];
  for (const edit of sorted) {
    const last = merged.at(-1);
    if (last && edit.start < last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, edit.end),
        replacement:
          (PRIORITY[edit.replacement] ?? 0) > (PRIORITY[last.replacement] ?? 0)
            ? edit.replacement
            : last.replacement,
      };
    } else {
      merged.push(edit);
    }
  }
  return merged;
}

function isHighSurrogate(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff;
}

/** A cut at `at`, moved back (or forward) to whitespace within the slack, never inside a surrogate pair. */
function cutPoint(text: string, at: number, direction: 'back' | 'forward'): number {
  const limit =
    direction === 'back' ? Math.max(0, at - CUT_SLACK) : Math.min(text.length, at + CUT_SLACK);
  for (
    let i = at;
    direction === 'back' ? i > limit : i < limit;
    i += direction === 'back' ? -1 : 1
  ) {
    if (/\s/.test(text.charAt(i))) return i;
  }
  return isHighSurrogate(text, at - 1) ? at - 1 : at;
}

/** Text ranges the model reads: the whole note, or its head and tail when it is longer than `maxChars`. */
function keptRanges(text: string, maxChars: number): [number, number][] {
  if (text.length <= maxChars) return [[0, text.length]];
  const budget = Math.max(0, maxChars - ELISION_MARKER.length);
  const headEnd = cutPoint(text, Math.floor(budget * NOTE_HEAD_SHARE), 'back');
  const tailStart = cutPoint(text, text.length - (budget - headEnd), 'forward');
  return [
    [0, headEnd],
    [Math.max(headEnd, tailStart), text.length],
  ];
}

function editsIn(
  text: string,
  [from, to]: [number, number],
  redactTerms: readonly string[],
): Edit[] {
  const index = createQuoteIndex(text.slice(from, to));
  const shift = (span: MaskSpan, replacement: string): Edit => ({
    start: span.start + from,
    end: span.end + from,
    replacement,
  });
  return [
    ...findPatientMentions(index, redactTerms).map((span) => shift(span, REDACTION_PLACEHOLDER)),
    ...findDelimiterTags(index).map((span) => shift(span, DEFANGED_TAG)),
  ];
}

interface Segment {
  readonly from: number;
  readonly to: number;
  readonly originalFrom: number;
  readonly originalTo: number;
  readonly literal: boolean;
}

/** Applies non-overlapping, sorted edits to `text`. */
function applyEdits(text: string, edits: readonly Edit[]): { text: string; segments: Segment[] } {
  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let length = 0;
  const push = (
    value: string,
    originalFrom: number,
    originalTo: number,
    literal: boolean,
  ): void => {
    if (value.length === 0) return;
    parts.push(value);
    segments.push({ from: length, to: length + value.length, originalFrom, originalTo, literal });
    length += value.length;
  };
  for (const edit of edits) {
    push(text.slice(cursor, edit.start), cursor, edit.start, true);
    push(edit.replacement, edit.start, edit.end, false);
    cursor = edit.end;
  }
  push(text.slice(cursor), cursor, text.length, true);
  return { text: parts.join(''), segments };
}

/**
 * Neutralizes delimiter-shaped tags in any host text (specialty, note),
 * whatever their case, spacing, attributes, invisible characters, fullwidth
 * brackets or HTML entities.
 */
export function defangTags(text: string): string {
  const edits = mergeEdits(
    findDelimiterTags(createQuoteIndex(text)).map((span) => ({
      ...span,
      replacement: DEFANGED_TAG,
    })),
  );
  return applyEdits(text, edits).text;
}

/**
 * Masks `redactTerms` (see `masking.ts`: full names and name runs, distinctive
 * name parts, whole identifiers), neutralizes delimiter-shaped tags and, past
 * `maxChars`, keeps the head and the tail of the note with an elision marker
 * between them. Linear in the note length per term.
 */
export function prepareNote(
  original: string,
  options: { readonly redactTerms?: readonly string[]; readonly maxChars?: number } = {},
): PreparedNote {
  const ranges = keptRanges(original, options.maxChars ?? MAX_NOTE_CHARS);
  const truncated = ranges.length > 1;
  const redactTerms = options.redactTerms ?? [];
  const edits = mergeEdits([
    ...ranges.flatMap((range) => editsIn(original, range, redactTerms)),
    ...(truncated && ranges[0] && ranges[1]
      ? [{ start: ranges[0][1], end: ranges[1][0], replacement: ELISION_MARKER }]
      : []),
  ]);
  const { text, segments } = applyEdits(original, edits);

  const segmentAt = (position: number): Segment | undefined => {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (segment === undefined) return undefined;
      if (position < segment.from) high = middle - 1;
      else if (position >= segment.to) low = middle + 1;
      else return segment;
    }
    return undefined;
  };

  return {
    text,
    original,
    truncated,
    redactions: edits.filter((edit) => edit.replacement === REDACTION_PLACEHOLDER).length,
    defanged: edits.filter((edit) => edit.replacement === DEFANGED_TAG).length,
    toOriginal(start, end) {
      const first = segmentAt(start);
      const last = segmentAt(Math.max(start, end - 1));
      if (!first || !last) return { start, end };
      return {
        start: first.literal ? first.originalFrom + (start - first.from) : first.originalFrom,
        end: last.literal ? last.originalFrom + (end - last.from) : last.originalTo,
      };
    },
  };
}
