import { describe, expect, it } from 'vitest';
import { normalizeLanguageTag, primaryLanguage } from './language.ts';

describe('language tags', () => {
  it('canonicalizes valid BCP-47 tags', () => {
    expect(normalizeLanguageTag('EN-us')).toBe('en-US');
    expect(normalizeLanguageTag(' es_VE ')).toBe('es-VE');
    expect(normalizeLanguageTag('pt-BR')).toBe('pt-BR');
    expect(normalizeLanguageTag('es-419')).toBe('es-419');
  });

  it('rejects what is not a tag', () => {
    expect(normalizeLanguageTag(undefined)).toBeUndefined();
    expect(normalizeLanguageTag('')).toBeUndefined();
    expect(normalizeLanguageTag('Spanish please')).toBeUndefined();
    expect(normalizeLanguageTag('e')).toBeUndefined();
  });

  it('extracts the primary language', () => {
    expect(primaryLanguage('es-VE')).toBe('es');
    expect(primaryLanguage('EN')).toBe('en');
    expect(primaryLanguage('not a tag')).toBeUndefined();
  });
});
