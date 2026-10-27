import type { MappingIssue } from './operation-outcome.ts';

/**
 * Characters a FHIR `string` may not contain (R4 allows only tab, line feed
 * and carriage return among the controls): C0 controls, DEL. Postgres `jsonb`
 * and `text` also refuse NUL, so one stray byte would fail the whole
 * consultation downstream.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** UTF-16 halves without their pair: not valid Unicode, refused by Postgres `jsonb`. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** FHIR R4: "strings SHALL NOT exceed 1 MB" (attachments, `base64Binary`, may be larger). */
export const MAX_FHIR_STRING_LENGTH = 1024 * 1024;

/** Text without control characters or lone surrogates (replaced by U+FFFD). */
export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '').replace(LONE_SURROGATES, '�');
}

function needsCleaning(text: string): boolean {
  CONTROL_CHARACTERS.lastIndex = 0;
  LONE_SURROGATES.lastIndex = 0;
  return CONTROL_CHARACTERS.test(text) || LONE_SURROGATES.test(text);
}

export interface SanitizedJson {
  /** The input with every string cleaned; the same reference when nothing changed. */
  readonly value: unknown;
  /** One warning per cleaned string, one error per oversized string. */
  readonly issues: readonly MappingIssue[];
}

/**
 * Cleans parsed JSON from a host before it is mapped or stored: removes
 * control characters and lone surrogates from every string and key (with a
 * warning at its FHIRPath-like location), and flags strings over
 * {@link MAX_FHIR_STRING_LENGTH} as errors. Pure; the input is not modified.
 */
export function sanitizeFhirJson(input: unknown, root = 'Bundle'): SanitizedJson {
  const issues: MappingIssue[] = [];

  function walk(value: unknown, path: string, key: string | undefined): unknown {
    if (typeof value === 'string') {
      if (value.length > MAX_FHIR_STRING_LENGTH && key !== 'data') {
        issues.push({
          severity: 'error',
          code: 'too-long',
          message: `string of ${String(value.length)} characters; FHIR strings may not exceed 1 MB`,
          expression: path,
        });
      }
      if (!needsCleaning(value)) {
        return value;
      }
      issues.push({
        severity: 'warning',
        code: 'invalid',
        message: 'control characters (or invalid Unicode) removed from the text',
        expression: path,
      });
      return stripControlCharacters(value);
    }
    if (Array.isArray(value)) {
      const items = value.map((item: unknown, index) =>
        walk(item, `${path}[${String(index)}]`, key),
      );
      return items.some((item, index) => item !== value[index]) ? items : value;
    }
    if (value !== null && typeof value === 'object') {
      let changed = false;
      const copy: Record<string, unknown> = {};
      for (const [rawKey, inner] of Object.entries(value)) {
        const cleanKey = needsCleaning(rawKey) ? stripControlCharacters(rawKey) : rawKey;
        if (cleanKey !== rawKey) {
          issues.push({
            severity: 'warning',
            code: 'invalid',
            message: 'control characters removed from a property name',
            expression: path,
          });
        }
        const cleaned = walk(inner, `${path}.${cleanKey}`, cleanKey);
        if (cleaned !== inner || cleanKey !== rawKey) {
          changed = true;
        }
        copy[cleanKey] = cleaned;
      }
      return changed ? copy : value;
    }
    return value;
  }

  const value = walk(input, root, undefined);
  return { value, issues };
}
