import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale, messagesFor } from './i18n/index.ts';
import { mockApiCopy } from './mocks/api-copy.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.each(LOCALES)('clinical review in %s', (locale: Locale) => {
  const t = messagesFor(locale);
  const review = t.review;
  const store = createMockStore();
  store.setLocale(locale);
  const finding = (id: string) => store.reviewer.getFinding(id);

  it('lists shadow findings under the shadow-mode banner, highest severity first', async () => {
    renderApp('/clinical-review', { locale });
    expect(await screen.findByText(review.banner.shadowStrong)).toBeInTheDocument();
    const summaries = ['cf-001', 'cf-002', 'cf-003', 'cf-004'].map((id) =>
      escape(finding(id).summary.slice(0, 20)),
    );
    const rows = await screen.findAllByRole('link', { name: new RegExp(summaries.join('|')) });
    expect(rows.length).toBe(4);
    expect(rows[0]).toHaveTextContent(review.severities.high);
    expect(rows.at(-1)).toHaveTextContent(review.severities.medium);
    // The live pre-visit question is not in the shadow list.
    expect(screen.queryByText(finding('cf-005').summary)).not.toBeInTheDocument();
    expect(screen.getByText(review.metrics.patients)).toBeInTheDocument();
    // The nav counts the open shadow findings (desktop and phone navs).
    for (const link of screen.getAllByRole('link', { name: new RegExp(t.nav.review) })) {
      expect(link).toHaveTextContent('4');
    }
  });

  it('shows a trend drawn to scale with its cited results', async () => {
    renderApp('/clinical-review/cf-001', { locale });
    const values = [1.05, 1.1, 1.4, 1.75]
      .map((value) => value.toLocaleString(locale === 'en' ? 'en-US' : 'es'))
      .join(' → ');
    const chart = await screen.findByRole('img', {
      name: new RegExp(escape(`${finding('cf-001').trend?.label ?? ''}: ${values} mg/dL`)),
    });
    expect(chart.querySelectorAll('circle')).toHaveLength(4);
    // Quotes are the record's words, never translated.
    expect(screen.getAllByTestId('evidence-quote').map((mark) => mark.textContent)).toEqual([
      'Creatinina: 1.1 mg/dL',
      'Creatinina: 1.4 mg/dL',
      'Creatinina: 1.75 mg/dL',
    ]);
    expect(screen.getByText(review.detail.suggestionTitle)).toBeInTheDocument();
  });

  it('highlights each quote inside its note and shows the agent trace', async () => {
    const { user } = renderApp('/clinical-review/cf-003', { locale });
    const marks = await screen.findAllByTestId('evidence-quote');
    expect(marks.map((mark) => mark.textContent)).toEqual([
      'Refiere cefalea frontal vespertina de dos semanas',
      'Persiste cefalea, ahora casi diaria, que cede parcialmente con analgésicos',
      'Acude nuevamente por cefalea que la despierta en la noche',
    ]);
    expect(marks[0]?.closest('blockquote')).toHaveTextContent('Alergias: niega.');
    await user.click(screen.getByText(review.detail.traceTitle));
    expect(screen.getByText(review.steps.labTrend(review.testNames['creatinine']))).toBeVisible();
    expect(screen.getByText(review.steps.submitted(2))).toBeVisible();
  });

  it('asks for a reason before marking a finding not relevant, and sends nothing without it', async () => {
    const rendered = renderApp('/clinical-review/cf-002', { locale });
    const { user } = rendered;
    await user.click(await screen.findByRole('button', { name: review.verdicts.not_relevant }));
    await user.click(screen.getByRole('button', { name: review.verdict.submit }));
    expect(await screen.findByText(review.verdict.reasonRequired)).toBeInTheDocument();
    expect(rendered.store.reviewer.getFinding('cf-002').status).toBe('open');
    await user.type(
      screen.getByLabelText(review.verdict.reasonRequiredLabel),
      'El AINE ya se suspendió',
    );
    await user.click(screen.getByRole('button', { name: review.verdict.submit }));
    expect(
      await screen.findByText(new RegExp(escape(review.verdict.summaryPrefix.trim()))),
    ).toHaveTextContent(review.verdicts.not_relevant.toLowerCase());
    expect(rendered.store.reviewer.getFinding('cf-002').review).toMatchObject({
      verdict: 'not_relevant',
      reason: 'El AINE ya se suspendió',
    });
  });

  it('records a relevant verdict and lets the reviewer change it', async () => {
    const rendered = renderApp('/clinical-review/cf-001', { locale });
    const { user } = rendered;
    await user.click(await screen.findByRole('button', { name: review.verdicts.relevant }));
    await user.click(screen.getByRole('button', { name: review.verdict.submit }));
    expect(
      await screen.findByText(new RegExp(escape(review.verdict.summaryPrefix.trim()))),
    ).toHaveTextContent(review.verdicts.relevant.toLowerCase());
    expect(rendered.store.reviewer.getFinding('cf-001').status).toBe('relevant');
    await user.click(screen.getByRole('button', { name: review.verdict.change }));
    expect(screen.getByRole('button', { name: review.verdicts.already_known })).toBeInTheDocument();
  });

  it('needs who validated a category before it goes live', async () => {
    const { user } = renderApp('/clinical-review/categories', { locale });
    const heading = await screen.findByRole('heading', {
      name: new RegExp(review.categories.lab_trend),
    });
    const row = heading.closest('li');
    if (!row) throw new Error('flag row not found');
    await user.click(within(row).getByRole('button', { name: review.flags.promote }));
    await user.click(within(row).getByRole('button', { name: review.flags.confirm }));
    expect(within(row).getByText(review.flags.validatorRequired)).toBeInTheDocument();
    await user.type(within(row).getByLabelText(review.flags.validatorLabel), 'Dra. Castellanos');
    await user.click(within(row).getByRole('button', { name: review.flags.confirm }));
    await waitFor(() => {
      expect(
        within(row).getByText(
          new RegExp(escape(review.flags.validatedBy('Dra. Castellanos', undefined))),
        ),
      ).toBeInTheDocument();
    });
    expect(within(row).getByRole('button', { name: review.flags.demote })).toBeInTheDocument();
    // The reserved category has no switch.
    const reserved = screen
      .getByRole('heading', { name: review.categories.similar_patients })
      .closest('li');
    expect(reserved && within(reserved).queryByRole('switch')).toBeNull();
    // Descriptions come from the API, in the request's language.
    expect(
      screen.getByText(mockApiCopy(locale).reviewer.descriptions.lab_trend),
    ).toBeInTheDocument();
  });

  it('shows only live questions on the patient page', async () => {
    renderApp('/patients/pat-001', { locale });
    expect(
      await screen.findByRole('heading', { name: new RegExp(review.preVisit.title) }),
    ).toBeInTheDocument();
    expect(screen.getByText(finding('cf-005').summary)).toBeInTheDocument();
    // Shadow findings of the same patient never appear there.
    expect(screen.queryByText(finding('cf-001').summary)).not.toBeInTheDocument();
  });

  it('shows no question section when the patient has none', async () => {
    renderApp('/patients/pat-002', { locale });
    await screen.findAllByText(/José Luis Méndez/);
    expect(
      screen.queryByRole('heading', { name: new RegExp(review.preVisit.title) }),
    ).not.toBeInTheDocument();
  });
});
