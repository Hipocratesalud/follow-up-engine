/**
 * The inbox's active UI locale. English is the default (a deployment can
 * pick another, see {@link deploymentDefaultLocale}); Spanish is the second
 * locale for Latin American hosts. The choice is remembered per
 * viewer (localStorage, which may be blocked: every access is guarded) and
 * mirrored on `<html lang>`. The locale also travels to the API on every
 * call (`Accept-Language`), so the labels the API writes come back in it.
 *
 * Kept outside React on purpose: the API client, error helpers and the
 * formatters read it at call time; components subscribe through `useLocale`.
 */

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** localStorage key of the viewer's choice. */
export const LOCALE_STORAGE_KEY = 'inbox-locale';

/** BCP-47 tag each locale formats dates and numbers with. */
export const INTL_LOCALES: Readonly<Record<Locale, string>> = {
  en: 'en-US',
  es: 'es',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The deployment's default UI language: `<meta name="inbox-default-locale">`
 * in index.html, which the API rewrites when it serves the inbox
 * (`DEFAULT_UI_LOCALE`). English when absent or unknown.
 */
export function deploymentDefaultLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const content = document
    .querySelector('meta[name="inbox-default-locale"]')
    ?.getAttribute('content');
  return isLocale(content) ? content : DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  try {
    const stored = globalThis.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function storeLocale(locale: Locale): void {
  try {
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage can be blocked (private mode): the choice still holds for this visit.
  }
}

function syncDocument(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

let current: Locale = readStoredLocale() ?? deploymentDefaultLocale();
const listeners = new Set<() => void>();
syncDocument(current);

/** The active locale. */
export function getLocale(): Locale {
  return current;
}

/** Switches the UI locale: remembered, mirrored on `<html lang>`, subscribers notified. */
export function setLocale(locale: Locale): void {
  storeLocale(locale);
  syncDocument(locale);
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-reads the remembered choice (the deployment's default when none,
 * English unless configured): a fresh page load does this at import; tests
 * call it after clearing storage.
 */
export function resetLocale(): void {
  const next = readStoredLocale() ?? deploymentDefaultLocale();
  syncDocument(next);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}
