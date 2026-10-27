import { primaryLanguage } from '@follow-up-engine/core';
import { EN } from './en.ts';
import { ES } from './es.ts';
import type { ApiMessages } from './messages.ts';

/** Languages the API has a catalog for; the first is the default. */
export const API_LOCALES = ['en', 'es'] as const;
export type ApiLocale = (typeof API_LOCALES)[number];
export const DEFAULT_API_LOCALE: ApiLocale = 'en';

const CATALOGS: Readonly<Record<ApiLocale, ApiMessages>> = { en: EN, es: ES };

function isApiLocale(value: string | undefined): value is ApiLocale {
  return (API_LOCALES as readonly (string | undefined)[]).includes(value);
}

/** The catalog of a locale. */
export function messagesFor(locale: ApiLocale): ApiMessages {
  return CATALOGS[locale];
}

/**
 * Languages of an `Accept-Language` header, by preference: highest `q`
 * first, header order breaking ties; `q=0` and `*` are dropped.
 */
export function acceptedLanguages(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((part, index) => {
      const [range = '', ...params] = part.trim().split(';');
      const q = params
        .map((param) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)?.[1])
        .find((value) => value !== undefined);
      return { range: range.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter(({ range, q }) => range !== '' && range !== '*' && Number.isFinite(q) && q > 0)
    .sort((left, right) => right.q - left.q || left.index - right.index)
    .map(({ range }) => range);
}

/**
 * The locale of a request's labels (docs/adr/0006): the first language of
 * the user's `Accept-Language` the API has a catalog for, else the clinic's
 * locale (`ClinicSettings.locale`) when it has one, else English.
 */
export function resolveApiLocale(
  acceptLanguage: string | undefined,
  clinicLocale?: string,
): ApiLocale {
  for (const tag of acceptedLanguages(acceptLanguage)) {
    const language = primaryLanguage(tag);
    if (isApiLocale(language)) return language;
  }
  const clinic = primaryLanguage(clinicLocale);
  return isApiLocale(clinic) ? clinic : DEFAULT_API_LOCALE;
}
