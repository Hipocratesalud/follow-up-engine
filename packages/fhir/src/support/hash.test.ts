import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, fnv1a64, isFhirId, toFhirId } from './hash.ts';

describe('canonicalJson / contentHash', () => {
  it('does not depend on key order or undefined members', () => {
    const a = { b: 1, a: [{ y: 2, x: 1 }], c: undefined };
    const b = { a: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes when content changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('matches the FNV-1a 64 reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe('toFhirId', () => {
  it('keeps valid ids', () => {
    expect(toFhirId('exp-01.a')).toBe('exp-01.a');
  });

  it('sanitizes invalid characters and keeps distinct inputs distinct', () => {
    const a = toFhirId('case:pat 1/a');
    const b = toFhirId('case:pat 1/b');
    expect(isFhirId(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith('case-pat-1-a-')).toBe(true);
  });

  it('shortens long ids to 64 characters', () => {
    const id = toFhirId('x'.repeat(200));
    expect(id).toHaveLength(64);
    expect(isFhirId(id)).toBe(true);
  });

  it('handles an empty id', () => {
    expect(isFhirId(toFhirId(''))).toBe(true);
  });
});
