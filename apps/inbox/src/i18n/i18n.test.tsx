import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { en } from './en.ts';
import { es } from './es.ts';
import { getLocale, LOCALE_STORAGE_KEY, resetLocale } from './locale.ts';
import { messagesFor } from './messages.ts';

/** An argument every message accepts: reads as the number 2, the text "2" and a list of "2". */
class Sample extends String {
  join(): string {
    return this.toString();
  }
}

/** Every string of a catalog with its key path; functions are called with sample arguments. */
function strings(catalog: unknown, path = ''): [string, string][] {
  if (typeof catalog === 'string') return [[path, catalog]];
  if (typeof catalog === 'function') {
    const sample = (catalog as (...args: unknown[]) => unknown)(
      ...Array.from({ length: catalog.length }, () => new Sample('2')),
    );
    return typeof sample === 'string' ? [[path, sample]] : [];
  }
  if (typeof catalog === 'object' && catalog !== null) {
    return Object.entries(catalog).flatMap(([key, value]) =>
      strings(value, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/** Words that are the same in both languages: brands, codes, units, names. */
const SAME_IN_BOTH = new Set([
  'common.noValue',
  'common.separator',
  'common.languageNames.en',
  'common.languageNames.es',
  'nav.demo',
  'time.seconds',
  'time.milliseconds',
  'labels.conditionStatuses.probable',
  'labels.sexShort.female',
  'labels.sexShort.male',
  'labels.channels.whatsapp',
  'why.statuses.final',
  'labels.channels.sms',
  'labels.source',
  'consultation.labs.4548-4',
  'consultation.labs.14957-5',
  'consultation.labs.3016-3',
  'review.list.optionWithCount',
  'review.trend.caption',
  'review.trend.description',
  'review.detail.citationCaption',
  'review.detail.discardedItem',
  'review.summaries.expectations',
  'review.testNames.hba1c',
  'contact.attemptTitle',
  'feedback.reasonSuffix',
  'extraction.probable',
  // HIP-141 Metrics: punctuation and numbers only ("A – B", "—", "Label 3", "2 tokens").
  'metrics.periodRange',
  'metrics.tiles.none',
  'metrics.funnel.summary',
  'metrics.extraction.legend',
  'metrics.ai.tokens',
  // "<kind>: <test name>": punctuation only, both parameters are translated elsewhere.
  'extraction.planItemNamed',
  // The evaluator lab: a clinical word the same in both languages, and an ICD-10 code.
  'lab.interpretations.normal',
  'lab.diagnosisCodePlaceholder',
]);

describe('catalogs', () => {
  it('have the same keys in English and Spanish', () => {
    expect(strings(es).map(([key]) => key)).toEqual(strings(en).map(([key]) => key));
  });

  it('translate every message: a Spanish string equal to the English one is a missed key', () => {
    const english = new Map(strings(en));
    const untranslated = strings(es)
      .filter(([key, value]) => english.get(key) === value && !SAME_IN_BOTH.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('keep Spanish out of the English catalog', () => {
    const spanish = strings(en).filter(
      ([key, value]) =>
        key !== 'common.languageNames.es' &&
        key !== 'review.flags.validatorPlaceholder' &&
        /[ñáéíóú¿¡]/i.test(value),
    );
    expect(spanish).toEqual([]);
  });
});

describe('language switch', () => {
  it('starts in English, with <html lang="en">', async () => {
    renderApp('/inbox');
    expect(
      await screen.findByRole('heading', { level: 1, name: en.inbox.title }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(getLocale()).toBe('en');
  });

  it('switches to Spanish: the UI, <html lang>, the remembered choice and the API labels', async () => {
    const languages: string[] = [];
    const { user, store } = renderApp('/inbox/case-001', {
      handlers: () => [
        // Observes every request, then lets the mock API answer it.
        http.all('*/api/*', ({ request }) => {
          languages.push(request.headers.get('Accept-Language') ?? '');
        }),
      ],
    });
    const reason = store.getCase('case-001').reasons[0]?.label ?? '';
    expect((await screen.findAllByText(reason)).length).toBeGreaterThan(0);
    expect(languages.length).toBeGreaterThan(0);
    expect(new Set(languages)).toEqual(new Set(['en']));

    const group = screen.getByRole('group', { name: en.common.language });
    await user.click(within(group).getByRole('button', { name: 'Español' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: es.inbox.title }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('es');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('es');
    expect(within(group).getByRole('button', { name: 'Español' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The API labels come back in Spanish: every query was fetched again with `es`.
    store.setLocale('es');
    const spanishReason = store.getCase('case-001').reasons[0]?.label ?? '';
    expect(spanishReason).not.toBe(reason);
    expect((await screen.findAllByText(spanishReason)).length).toBeGreaterThan(0);
    expect(languages.at(-1)).toBe('es');
  });

  it('remembers the choice for the next visit', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    resetLocale();
    expect(getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    resetLocale();
    expect(getLocale()).toBe('en');
  });

  it("starts in the deployment's default language until the viewer picks one", () => {
    const meta = document.createElement('meta');
    meta.name = 'inbox-default-locale';
    meta.content = 'es';
    document.head.append(meta);
    try {
      localStorage.removeItem(LOCALE_STORAGE_KEY);
      resetLocale();
      expect(getLocale()).toBe('es');
      expect(document.documentElement.lang).toBe('es');
      // The viewer's own choice wins over the deployment's default.
      localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
      resetLocale();
      expect(getLocale()).toBe('en');
      // An unknown default falls back to English.
      localStorage.removeItem(LOCALE_STORAGE_KEY);
      meta.content = 'klingon';
      resetLocale();
      expect(getLocale()).toBe('en');
    } finally {
      meta.remove();
      localStorage.removeItem(LOCALE_STORAGE_KEY);
      resetLocale();
    }
  });

  it('still switches when the browser blocks storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      resetLocale();
      const { user } = renderApp('/recovery');
      await screen.findByRole('heading', { level: 1, name: en.recovery.title });
      await user.click(screen.getByRole('button', { name: 'Español' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: es.recovery.title }),
      ).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it('formats dates and numbers in the active language', async () => {
    const { user } = renderApp('/demo');
    const date = await screen.findByText(
      (_, element) => element?.tagName === 'TIME' && /\d{4}/.test(element.textContent),
      { selector: 'p time' },
    );
    expect(date.textContent).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    await user.click(screen.getByRole('button', { name: 'Español' }));
    await waitFor(() => {
      expect(date.textContent).toMatch(/^[a-zé]+, \d{1,2} de [a-z]+ de \d{4}$/);
    });
    expect(messagesFor('es').time.days(1)).toBe('1 día');
  });
});
