import { createQuoteIndex } from './quote.ts';

/**
 * What leaves for a third-party model is the note, minus what the engine can
 * mask: the patient's names and identifiers (the host sends them in the same
 * Bundle, see `NoteExtractionInput.redactTerms`), anything shaped like one of
 * the prompt's own delimiters, and anything past {@link MAX_NOTE_CHARS}.
 *
 * The prepared text keeps a map back to the original, so evidence quotes the
 * model copies from the prepared text are stored verbatim from the original
 * note.
 */

/** Longest note (UTF-16 code units) sent to a model; the rest is cut and reported. */
export const MAX_NOTE_CHARS = 20_000;

/** What a masked name or identifier becomes in the prompt. */
export const REDACTION_PLACEHOLDER = '[REDACTADO]';
/** What a delimiter-shaped tag inside host text becomes. */
export const DEFANGED_TAG = '[etiqueta]';

/**
 * Tags shaped like the prompt's delimiters, whatever their case or spacing:
 * `</clinical_note>`, `</CLINICAL_NOTE >`, `< /clinical-note>`, `<note_metadata>`.
 */
const DELIMITER_TAG = /<\s*\/?\s*(?:clinical|note)[\s_-]*(?:note|metadata)\s*\/?\s*>/gi;

/**
 * Given names that are also everyday clinical words: masked only as part of
 * the full name, never alone ("refiere dolores articulares").
 */
const AMBIGUOUS_NAME_PARTS = new Set([
  'alta',
  'amparo',
  'angeles',
  'blanca',
  'caridad',
  'consuelo',
  'cruz',
  'dolores',
  'esperanza',
  'fe',
  'gloria',
  'luz',
  'mar',
  'mercedes',
  'paz',
  'pilar',
  'remedios',
  'rosa',
  'salud',
  'socorro',
  'sol',
]);
const NAME_PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'da',
  'do',
  'dos',
  'van',
  'von',
]);
const MIN_PART_LENGTH = 3;
const MIN_ID_DIGITS = 5;

export interface PreparedNote {
  /** The text the model sees. */
  readonly text: string;
  /** The note as the host sent it. */
  readonly original: string;
  /** Whether the note was longer than {@link MAX_NOTE_CHARS} and was cut. */
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

/** Where the variants of one redaction term appear in the note. */
function termEdits(index: ReturnType<typeof createQuoteIndex>, term: string): Edit[] {
  const normalized = index.normalized.text;
  const needles = new Set<string>();
  const full = createQuoteIndex(term).normalized.text;
  if (full.replace(/[^a-z0-9]/g, '').length >= MIN_PART_LENGTH) needles.add(full);
  for (const part of full.split(/[\s,.;]+/)) {
    const letters = part.replace(/[^a-z0-9]/g, '');
    if (
      letters.length >= MIN_PART_LENGTH &&
      !NAME_PARTICLES.has(part) &&
      !AMBIGUOUS_NAME_PARTS.has(part)
    ) {
      needles.add(part);
    }
  }
  const edits: Edit[] = [];
  const isWordChar = (char: string | undefined): boolean =>
    char !== undefined && /[\p{L}\p{N}]/u.test(char);
  for (const needle of needles) {
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1)) {
      if (isWordChar(normalized[at - 1]) || isWordChar(normalized[at + needle.length])) continue;
      const span = index.spanOf(at, at + needle.length);
      if (span)
        edits.push({ start: span.start, end: span.end, replacement: REDACTION_PLACEHOLDER });
    }
  }
  // Identifiers: the same digits however they are punctuated (V-12.345.678, 12345678).
  const digits = term.replace(/\D/g, '');
  if (digits.length >= MIN_ID_DIGITS) {
    const source = index.source;
    for (const match of source.matchAll(/\d(?:[\d.\-\s]*\d)?/g)) {
      if (match[0].replace(/\D/g, '').includes(digits)) {
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: REDACTION_PLACEHOLDER,
        });
      }
    }
  }
  return edits;
}

/** Overlapping or touching edits become one (the placeholder wins over a tag). */
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
          last.replacement === REDACTION_PLACEHOLDER || edit.replacement === REDACTION_PLACEHOLDER
            ? REDACTION_PLACEHOLDER
            : last.replacement,
      };
    } else {
      merged.push(edit);
    }
  }
  return merged;
}

/** Cuts at `max` code units without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Neutralizes delimiter-shaped tags in any host text (specialty, note). */
export function defangTags(text: string): string {
  return text.replace(DELIMITER_TAG, DEFANGED_TAG);
}

interface Segment {
  readonly from: number;
  readonly to: number;
  readonly originalFrom: number;
  readonly originalTo: number;
  readonly literal: boolean;
}

/**
 * Masks `redactTerms` (names and identifiers, compared without case or
 * accents, as whole words; each name part of three letters or more is masked
 * on its own too), neutralizes delimiter-shaped tags and cuts the note at
 * `maxChars`. Linear in the note length per term.
 */
export function prepareNote(
  original: string,
  options: { readonly redactTerms?: readonly string[]; readonly maxChars?: number } = {},
): PreparedNote {
  const maxChars = options.maxChars ?? MAX_NOTE_CHARS;
  const kept = cutAt(original, maxChars);
  const truncated = kept.length < original.length;
  const index = createQuoteIndex(kept);
  const redactionEdits = (options.redactTerms ?? []).flatMap((term) =>
    term.trim() === '' ? [] : termEdits(index, term),
  );
  const tagEdits: Edit[] = [...kept.matchAll(DELIMITER_TAG)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    replacement: DEFANGED_TAG,
  }));
  const edits = mergeEdits([...redactionEdits, ...tagEdits]);

  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let length = 0;
  const push = (text: string, originalFrom: number, originalTo: number, literal: boolean): void => {
    if (text.length === 0) return;
    parts.push(text);
    segments.push({ from: length, to: length + text.length, originalFrom, originalTo, literal });
    length += text.length;
  };
  for (const edit of edits) {
    push(kept.slice(cursor, edit.start), cursor, edit.start, true);
    push(edit.replacement, edit.start, edit.end, false);
    cursor = edit.end;
  }
  push(kept.slice(cursor), cursor, kept.length, true);

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
    text: parts.join(''),
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
