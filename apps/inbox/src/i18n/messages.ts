import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { es } from './es.ts';
import { getLocale, type Locale, subscribeLocale } from './locale.ts';
import type { Messages } from './types.ts';

export type { Messages };

const CATALOGS: Readonly<Record<Locale, Messages>> = { en, es };

/** The catalog of a locale. */
export function messagesFor(locale: Locale): Messages {
  return CATALOGS[locale];
}

/** The catalog of the active locale, for code outside React (error helpers, the API client). */
export function messages(): Messages {
  return CATALOGS[getLocale()];
}

/** The active locale; components re-render when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/** The catalog of the active locale; components re-render when it changes. */
export function useT(): Messages {
  return messagesFor(useLocale());
}
