import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale, messagesFor } from './i18n/index.ts';
import { formatDate } from './lib/format.ts';
import type { MockStore } from './mocks/store.ts';
import { renderApp, type RenderedApp } from './test/render.tsx';

/*
 * PRD V3 "Inbox cards per validated category": the doctor's inbox shows a
 * card per finding of a category the clinical team switched live, with the
 * evidence it quotes and three ratings; a shadow category never shows up,
 * and a rated card leaves the queue.
 */

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Switches categories live in the mock API before the app's first request. */
function live(...categories: readonly ('lab_trend' | 'unaddressed_symptom')[]) {
  return (store: MockStore) => {
    for (const category of categories) {
      store.reviewer.updateFlag({
        category,
        enabled: true,
        mode: 'live',
        validatedBy: 'Dra. Castellanos',
      });
    }
    return [];
  };
}

async function patientsLoaded(locale: Locale): Promise<void> {
  // The follow-up list rendered: the inbox fetched everything it shows.
  expect(await screen.findAllByText('María Fernanda Ortiz')).not.toHaveLength(0);
  await waitFor(() => {
    expect(screen.queryByLabelText(messagesFor(locale).inbox.loading)).not.toBeInTheDocument();
  });
}

async function goTo(rendered: RenderedApp, path: string): Promise<void> {
  await act(async () => {
    await rendered.router.navigate(path);
  });
}

describe.each(LOCALES)('live findings in the inbox (%s)', (locale: Locale) => {
  const t = messagesFor(locale);
  const COPY = t.liveFindings;

  it('never shows a shadow finding: no card while every category is in shadow', async () => {
    const rendered = renderApp('/inbox', { locale });
    await patientsLoaded(locale);
    // The mock clinic has open shadow findings (and a live pre-visit question, which goes to "Before the visit").
    expect(
      rendered.store.reviewer.listFindings({ mode: 'shadow', status: 'open' }).items.length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByTestId('inbox-finding-card')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: new RegExp(COPY.title) })).toBeNull();
    const shadow = rendered.store.reviewer.getFinding('cf-001');
    expect(screen.queryByText(shadow.summary)).toBeNull();
    expect(screen.queryByText(COPY.patientBadge(1))).toBeNull();
  });

  it('switching a category live in Categories brings its cards with evidence; back to shadow takes them out', async () => {
    const rendered = renderApp('/clinical-review/categories', { locale });
    const { user, store } = rendered;
    const heading = await screen.findByRole('heading', {
      name: new RegExp(t.review.categories.lab_trend),
    });
    const row = heading.closest('li');
    if (!row) throw new Error('flag row not found');
    await user.click(within(row).getByRole('button', { name: t.review.flags.promote }));
    await user.type(within(row).getByLabelText(t.review.flags.validatorLabel), 'Dra. Castellanos');
    await user.click(within(row).getByRole('button', { name: t.review.flags.confirm }));
    await within(row).findByRole('button', { name: t.review.flags.demote });

    await goTo(rendered, '/inbox');
    const cards = await screen.findAllByTestId('inbox-finding-card');
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (!card) throw new Error('no card');
    const finding = store.reviewer.getFinding('cf-001');
    expect(within(card).getByRole('heading', { name: finding.summary })).toBeInTheDocument();
    expect(card).toHaveTextContent(t.review.severities.high);
    expect(card).toHaveTextContent('María Fernanda Ortiz');
    expect(card).toHaveTextContent(finding.suggestion);
    // Verbatim quotes, with the source document and the date (never ISO).
    expect(
      within(card)
        .getAllByTestId('inbox-evidence-quote')
        .map((mark) => mark.textContent),
    ).toEqual(['Creatinina: 1.1 mg/dL', 'Creatinina: 1.4 mg/dL', 'Creatinina: 1.75 mg/dL']);
    const last = finding.citations[2];
    if (!last) throw new Error('no citation');
    expect(card).toHaveTextContent(
      t.review.beforeVisit.citationCaption(last.title, formatDate(last.date)),
    );
    expect(card.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const verdict of ['relevant', 'already_known', 'not_relevant'] as const) {
      expect(within(card).getByRole('button', { name: t.review.verdicts[verdict] })).toBeVisible();
    }
    // Only the live category: the shadow ones stay out.
    for (const id of ['cf-002', 'cf-003', 'cf-004', 'cf-006']) {
      expect(screen.queryByText(store.reviewer.getFinding(id).summary)).toBeNull();
    }
    // The section counts the cards; María's follow-up card says she has one.
    const section = screen.getByRole('region', { name: new RegExp(COPY.title) });
    expect(section).toHaveTextContent('1');
    expect(await screen.findByText(COPY.patientBadge(1))).toBeInTheDocument();

    await goTo(rendered, '/clinical-review/categories');
    const again = (
      await screen.findByRole('heading', { name: new RegExp(t.review.categories.lab_trend) })
    ).closest('li');
    if (!again) throw new Error('flag row not found');
    await user.click(within(again).getByRole('button', { name: t.review.flags.demote }));
    await within(again).findByRole('button', { name: t.review.flags.promote });
    await goTo(rendered, '/inbox');
    await patientsLoaded(locale);
    await waitFor(() => {
      expect(screen.queryAllByTestId('inbox-finding-card')).toHaveLength(0);
    });
    expect(screen.queryByText(COPY.patientBadge(1))).toBeNull();
  });

  it('"not relevant" asks for a reason on click and sends nothing without it', async () => {
    const rendered = renderApp('/inbox', { locale, handlers: live('lab_trend') });
    const { user, store } = rendered;
    const card = await screen.findByTestId('inbox-finding-card');
    await user.click(within(card).getByRole('button', { name: t.review.verdicts.not_relevant }));
    await user.click(within(card).getByRole('button', { name: t.review.verdict.submit }));
    expect(await within(card).findByText(t.review.verdict.reasonRequired)).toBeInTheDocument();
    expect(store.reviewer.getFinding('cf-001').status).toBe('open');
    expect(screen.getAllByTestId('inbox-finding-card')).toHaveLength(1);

    await user.type(
      within(card).getByLabelText(t.review.verdict.reasonRequiredLabel),
      'Ya en estudio por nefrología',
    );
    await user.click(within(card).getByRole('button', { name: t.review.verdict.submit }));
    await waitFor(() => {
      expect(screen.queryAllByTestId('inbox-finding-card')).toHaveLength(0);
    });
    expect(store.reviewer.getFinding('cf-001').review).toMatchObject({
      verdict: 'not_relevant',
      reason: 'Ya en estudio por nefrología',
    });
    expect(
      screen.getByText(COPY.rated(t.review.verdicts.not_relevant.toLowerCase())),
    ).toBeInTheDocument();
  });

  it('"relevant" and "already knew" record the feedback and remove each card', async () => {
    const rendered = renderApp('/inbox', {
      locale,
      handlers: live('lab_trend', 'unaddressed_symptom'),
    });
    const { user, store } = rendered;
    expect(await screen.findAllByTestId('inbox-finding-card')).toHaveLength(2);
    const trend = screen
      .getByRole('heading', { name: store.reviewer.getFinding('cf-001').summary })
      .closest('article');
    if (!trend) throw new Error('no trend card');
    await user.click(within(trend).getByRole('button', { name: t.review.verdicts.relevant }));
    await user.click(within(trend).getByRole('button', { name: t.review.verdict.submit }));
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-finding-card')).toHaveLength(1);
    });
    expect(store.reviewer.getFinding('cf-001').review?.verdict).toBe('relevant');

    const symptom = screen.getByTestId('inbox-finding-card');
    expect(symptom).toHaveTextContent(store.reviewer.getFinding('cf-003').summary);
    await user.click(
      within(symptom).getByRole('button', { name: t.review.verdicts.already_known }),
    );
    await user.click(within(symptom).getByRole('button', { name: t.review.verdict.submit }));
    await waitFor(() => {
      expect(screen.queryAllByTestId('inbox-finding-card')).toHaveLength(0);
    });
    expect(store.reviewer.getFinding('cf-003').review?.verdict).toBe('already_known');
    expect(
      screen.getByText(new RegExp(escape(t.review.verdicts.already_known.toLowerCase()))),
    ).toBeInTheDocument();
  });
});
