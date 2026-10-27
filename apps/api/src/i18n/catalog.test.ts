import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptedLanguages, API_LOCALES, messagesFor, resolveApiLocale } from './index.ts';

const CONFIG = join(import.meta.dirname, '../../../../config');

interface ConfigText {
  readonly code: string;
  readonly reason: string;
  readonly action?: string;
  readonly file: string;
}

/** Every `reason` (with its `suggestedAction`) of the rule and protocol files, recursively. */
function configTexts(): ConfigText[] {
  const texts: ConfigText[] = [];
  const visit = (value: unknown, file: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, file);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    const reason = node['reason'] as { code?: unknown; label?: unknown } | undefined;
    const action = node['suggestedAction'] as { label?: unknown } | undefined;
    if (typeof reason?.code === 'string' && typeof reason.label === 'string') {
      texts.push({
        code: reason.code,
        reason: reason.label,
        ...(typeof action?.label === 'string' ? { action: action.label } : {}),
        file,
      });
    }
    for (const child of Object.values(node)) visit(child, file);
  };
  for (const dir of ['rules', 'protocols']) {
    for (const name of readdirSync(join(CONFIG, dir)).filter((file) => file.endsWith('.json'))) {
      visit(JSON.parse(readFileSync(join(CONFIG, dir, name), 'utf8')), `${dir}/${name}`);
    }
  }
  return texts;
}

/** Every string of a catalog, by path (functions are called with sample arguments). */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const sample = (value as (...args: unknown[]) => unknown)('X', 'Y');
    return typeof sample === 'string' ? [[path, sample]] : [];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      strings(child, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

describe('API message catalogs', () => {
  const texts = configTexts();

  it('has display text in every locale for every rule and protocol item of config/', () => {
    expect(texts.length).toBeGreaterThan(20);
    for (const locale of API_LOCALES) {
      const { rules } = messagesFor(locale);
      for (const text of texts) {
        expect(rules[text.code]?.reason, `${locale}: ${text.code} (${text.file})`).toBeTruthy();
        if (text.action !== undefined) {
          expect(rules[text.code]?.action, `${locale}: ${text.code} action`).toBeTruthy();
        }
      }
    }
  });

  it('keeps no text for a reason code config/ no longer has', () => {
    const codes = new Set(texts.map((text) => text.code));
    for (const locale of API_LOCALES) {
      expect(Object.keys(messagesFor(locale).rules).filter((code) => !codes.has(code))).toEqual([]);
    }
  });

  it('is the source text of config/ in English', () => {
    const { rules } = messagesFor('en');
    for (const text of texts) {
      expect(rules[text.code]?.reason, text.code).toBe(text.reason);
      expect(rules[text.code]?.action, text.code).toBe(text.action);
    }
  });

  it('has no empty message and no untranslated Spanish text in English', () => {
    const english = strings(messagesFor('en'));
    for (const [path, value] of english) {
      expect(value.trim(), path).not.toBe('');
      expect(value, path).not.toMatch(/[áéíóúñ¿¡]/i);
    }
    for (const [path, value] of strings(messagesFor('es'))) {
      expect(value.trim(), path).not.toBe('');
    }
  });

  it('translates every sentence into Spanish (only names and codes may repeat)', () => {
    const english = new Map(strings(messagesFor('en')));
    const same = strings(messagesFor('es')).filter(
      ([path, value]) => english.get(path) === value && /[a-z]{3,}\s+[a-z]{3,}/i.test(value),
    );
    // Templates without words ("X: Y") and shared names ("WhatsApp", "TSH") may repeat.
    expect(same.map(([path]) => path)).toEqual([]);
  });
});

describe('request locale', () => {
  it('reads Accept-Language by preference', () => {
    expect(acceptedLanguages('es-VE,es;q=0.9,en;q=0.8')).toEqual(['es-VE', 'es', 'en']);
    expect(acceptedLanguages('en;q=0.2, pt-BR, *;q=0.1, fr;q=0')).toEqual(['pt-BR', 'en']);
    expect(acceptedLanguages(undefined)).toEqual([]);
    expect(acceptedLanguages(' , ;q=1')).toEqual([]);
  });

  it("picks the user's first supported language, else the clinic's, else English", () => {
    expect(resolveApiLocale('es-VE,en;q=0.5', 'en-US')).toBe('es');
    expect(resolveApiLocale('pt-BR,en;q=0.5', 'es-VE')).toBe('en');
    expect(resolveApiLocale('pt-BR,fr', 'es-VE')).toBe('es');
    expect(resolveApiLocale(undefined, 'es-419')).toBe('es');
    expect(resolveApiLocale('', undefined)).toBe('en');
    expect(resolveApiLocale('not a language', 'not a locale')).toBe('en');
    expect(resolveApiLocale('*', 'pt-BR')).toBe('en');
  });
});
