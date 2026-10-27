import type { Locale } from '../i18n/index.ts';

/**
 * A label the mock API writes, in each UI locale. The mock stands in for
 * apps/api, which writes its labels in the request's language
 * (`Accept-Language`): the mock keeps both and answers in the one asked for.
 * Clinical content (note text, quotes, patient names, diagnoses) is never
 * a `Localized`: it stays as written.
 */
export interface Localized {
  readonly en: string;
  readonly es: string;
}

/** Text resolved when a view is built, in the request's locale. */
export type Text = (locale: Locale) => string;

/** A `Localized` pair as {@link Text}. */
export function localized(value: Localized): Text {
  return (locale) => value[locale];
}

/** The same words in every locale (a name, a code, the clinic's own data). */
export function verbatim(value: string): Text {
  return () => value;
}
