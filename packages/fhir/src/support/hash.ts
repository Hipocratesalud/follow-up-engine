/**
 * Deterministic content hashing with no platform dependency (no `node:crypto`,
 * no Web Crypto), so the package stays pure and synchronous.
 *
 * Used only for idempotency fallbacks and id shortening, never for security.
 */

/** JSON with object keys sorted recursively, so equal content always serializes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sortKeys(inner)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over the UTF-8 bytes of `text`, as 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Stable short hash of any JSON-like value. */
export function contentHash(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}

const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;
const FHIR_ID_MAX = 64;

/**
 * Turns any engine identifier into a valid FHIR `id` (`[A-Za-z0-9\-.]{1,64}`).
 * Valid ids pass through unchanged; others are sanitized and, when too long,
 * shortened with a hash suffix so distinct inputs stay distinct.
 */
export function toFhirId(raw: string): string {
  if (FHIR_ID_PATTERN.test(raw)) {
    return raw;
  }
  const suffix = fnv1a64(raw);
  const prefix = raw.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, FHIR_ID_MAX - suffix.length - 1);
  return prefix === '' ? suffix : `${prefix}-${suffix}`;
}

/** Whether `value` is a valid FHIR `id`. */
export function isFhirId(value: string): boolean {
  return FHIR_ID_PATTERN.test(value);
}
