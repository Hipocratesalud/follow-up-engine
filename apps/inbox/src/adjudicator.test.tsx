import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/** PRD V2 workstream E: the adjudicator's decision under an ambiguous plan item. */

function planCaseId(): string {
  const probe = createMockStore();
  const page = probe.listCases({ limit: 200 });
  const found = page.items.find((item) =>
    probe.getCase(item.id).reasons.some((reason) => reason.planItem !== undefined),
  );
  if (found === undefined) throw new Error('expected a case with a plan item');
  return found.id;
}

describe.each(LOCALES)('adjudicator decision (%s)', (locale) => {
  const t = messagesFor(locale);

  it('shows the decision, its probability, reasons and quote; a doctor can discard it', async () => {
    const { user } = renderApp(`/cases/${planCaseId()}`, { locale });
    const panel = await screen.findByRole('region', { name: t.adjudication.title });
    expect(within(panel).getByText(t.adjudication.shadow)).toBeInTheDocument();
    expect(within(panel).getByText(t.adjudication.quotesLabel)).toBeInTheDocument();
    expect(within(panel).getByText(/%/u)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: t.adjudication.discard }));
    const dialog = await screen.findByRole('dialog', { name: t.adjudication.discardTitle });
    await user.click(within(dialog).getByRole('button', { name: t.adjudication.discardConfirm }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const after = await screen.findByRole('region', { name: t.adjudication.title });
    await waitFor(() => {
      expect(
        within(after).queryByRole('button', { name: t.adjudication.discard }),
      ).not.toBeInTheDocument();
    });
  });
});
