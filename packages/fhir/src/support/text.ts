import { stripControlCharacters } from './sanitize.ts';

/** Plain-text helpers for FHIR narrative (XHTML) and base64 attachments. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** The character of a numeric reference; the reference itself when it names no character. */
function fromCodePoint(codePoint: number, match: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : match;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return fromCodePoint(Number.parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith('#')) {
      return fromCodePoint(Number.parseInt(entity.slice(1), 10), match);
    }
    const lower = entity.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, lower) ? (NAMED_ENTITIES[lower] ?? match) : match;
  });
}

/** Collapses runs of spaces and blank lines; trims every line. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turns FHIR narrative XHTML (`Narrative.div`) into plain text. Block
 * elements and `<br>` become line breaks; every other tag is dropped and
 * entities are decoded. Not an HTML sanitizer: the output is text, never
 * rendered as markup.
 */
export function xhtmlToText(xhtml: string): string {
  const withBreaks = xhtml
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|section|blockquote|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ');
  return normalizeWhitespace(
    stripControlCharacters(decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))),
  );
}

/** FHIR `base64Binary`: standard alphabet, optional padding, whitespace ignored. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** What {@link decodeBase64Text} had to repair to turn the bytes into text. */
export type TextRepair =
  /** The declared charset is unknown: the bytes were read as UTF-8. */
  | 'charset'
  /** Byte sequences invalid in the charset were replaced by U+FFFD. */
  | 'bytes'
  /** Control characters (a NUL from a host's editor) were removed. */
  | 'control';

export interface DecodedText {
  readonly text: string;
  /** Empty when the bytes were clean text in their charset. */
  readonly repaired: readonly TextRepair[];
}

/** `charset` parameter of a MIME type (`text/plain; charset="ISO-8859-1"`). */
function charsetOf(contentType: string | undefined): string | undefined {
  return /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1];
}

/** The WHATWG encoding of a charset label; `undefined` for an unknown label. */
function encodingOf(charset: string): string | undefined {
  try {
    return new TextDecoder(charset).encoding;
  } catch {
    return undefined;
  }
}

/**
 * Decodes a base64 attachment as text in the charset its content type
 * declares (UTF-8 when none, or when the label is unknown). One bad byte
 * never costs the note: invalid sequences become U+FFFD and control
 * characters are removed, and {@link DecodedText.repaired} says so, for a
 * warning. `undefined` only when the data is not base64 at all.
 */
export function decodeBase64Text(data: string, contentType?: string): DecodedText | undefined {
  const compact = data.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(compact) || compact.length % 4 === 1) {
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
  const repaired: TextRepair[] = [];
  const charset = charsetOf(contentType);
  const declared = charset === undefined ? 'utf-8' : encodingOf(charset);
  if (declared === undefined) {
    repaired.push('charset');
  }
  const encoding = declared ?? 'utf-8';
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    decoded = new TextDecoder(encoding).decode(bytes);
    repaired.push('bytes');
  }
  const text = stripControlCharacters(decoded);
  if (text !== decoded) {
    repaired.push('control');
  }
  return { text, repaired };
}

/**
 * Decodes a base64 attachment as UTF-8 text; `undefined` if it is not valid
 * base64 or UTF-8. Control characters are dropped. Strict: the mapping uses
 * {@link decodeBase64Text}, which repairs instead of refusing.
 */
export function decodeBase64Utf8(data: string): string | undefined {
  const decoded = decodeBase64Text(data);
  return decoded === undefined || decoded.repaired.includes('bytes') ? undefined : decoded.text;
}

/** Encodes UTF-8 text as base64 (for building attachments). */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
