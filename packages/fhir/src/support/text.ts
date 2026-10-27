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

/**
 * Decodes a base64 attachment as UTF-8 text; `undefined` if it is not valid
 * base64 or UTF-8. Control characters (a NUL from a host's editor) are
 * dropped: the text is stored and read, never a binary.
 */
export function decodeBase64Utf8(data: string): string | undefined {
  const compact = data.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(compact) || compact.length % 4 === 1) {
    return undefined;
  }
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return stripControlCharacters(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
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
