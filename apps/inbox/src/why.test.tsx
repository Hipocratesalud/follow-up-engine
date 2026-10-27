import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CaseView } from './api/contract.ts';
import { messagesFor } from './i18n/index.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-142 "Why this?": one click on a reason shows the evidence a doctor can
 * check (the due date math, the doctor's words, the protocol and what
 * enrolled the patient), and "View documents" lists every document of the
 * patient, a cited one brought into view. English by default, Spanish too.
 */

function caseWith(layer: CaseView['reasons'][number]['layer']): CaseView {
  const page = createMockStore().listCases({ view: 'active', limit: 200 });
  const found = page.items.find((item) => item.reasons.some((reason) => reason.layer === layer));
  if (!found) throw new Error(`no active case with a ${layer} reason`);
  return found;
}

describe('"Why this?" on a case (English)', () => {
  const en = messagesFor('en');

  it('shows the due date math and the protocol enrollment of a protocol reason', async () => {
    const followUpCase = caseWith('protocol');
    const { user } = renderApp(`/cases/${followUpCase.id}`);
    const buttons = await screen.findAllByRole('button', { name: en.why.button });
    const reasonIndex = followUpCase.reasons.findIndex((reason) => reason.layer === 'protocol');
    const button = buttons[reasonIndex];
    if (!button) throw new Error('no Why this? button for the protocol reason');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: /^Why this: / });
    expect(within(region).getByTestId('why-due')).toHaveTextContent(/^Due .+ = .+ \+ \d+ days$/);
    expect(within(region).getByText(en.why.enrolledBecause)).toBeInTheDocument();
    expect(within(region).getByText(/^Coded diagnosis /)).toBeInTheDocument();
    expect(within(region).getByText(en.why.fulfilledBy)).toBeInTheDocument();
    await user.click(button);
    expect(screen.queryByRole('region', { name: /^Why this: / })).not.toBeInTheDocument();
  });

  it("quotes the doctor's words for a plan reason and opens the note in the documents drawer", async () => {
    const followUpCase = caseWith('doctor_plan');
    const { user } = renderApp(`/cases/${followUpCase.id}`);
    const buttons = await screen.findAllByRole('button', { name: en.why.button });
    const reasonIndex = followUpCase.reasons.findIndex((reason) => reason.layer === 'doctor_plan');
    const button = buttons[reasonIndex];
    if (!button) throw new Error('no Why this? button for the plan reason');
    await user.click(button);
    const region = screen.getByRole('region', { name: /^Why this: / });
    expect(within(region).getByText(en.why.doctorsPlan)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: en.why.showInDocuments }));
    const drawer = await screen.findByRole('dialog', {
      name: en.why.documentsTitle(followUpCase.patient.name),
    });
    expect(await within(drawer).findByText(en.why.cited)).toBeInTheDocument();
    // The doctor's words are marked inside the note's full text.
    expect(within(drawer).getByTestId('document-quote')).toBeInTheDocument();
  });

  it('lists every document of the patient from "View documents", filterable by kind', async () => {
    const followUpCase = caseWith('doctor_plan');
    const { user } = renderApp(`/cases/${followUpCase.id}`);
    await user.click(await screen.findByRole('button', { name: en.why.viewDocuments }));
    const drawer = await screen.findByRole('dialog', {
      name: en.why.documentsTitle(followUpCase.patient.name),
    });
    const filters = await within(drawer).findByRole('group', { name: en.why.filterLabel });
    const notes = within(filters).getByRole('button', {
      name: new RegExp(`^${en.why.filters.note}`),
    });
    await user.click(notes);
    expect(notes).toHaveAttribute('aria-pressed', 'true');
    const items = within(drawer).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).toHaveTextContent(/Clinical note/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('"Why this?" in Spanish', () => {
  const es = messagesFor('es');

  it('explains the reason and lists the documents in Spanish', async () => {
    const followUpCase = caseWith('protocol');
    const { user } = renderApp(`/cases/${followUpCase.id}`, { locale: 'es' });
    const [button] = await screen.findAllByRole('button', { name: es.why.button });
    if (!button) throw new Error('no ¿Por qué? button');
    await user.click(button);
    const region = screen.getByRole('region', { name: /^Por qué: / });
    expect(within(region).getByTestId('why-due')).toHaveTextContent(/^Vence el .+ = .+ días$/);
    expect(within(region).getByText(es.why.fulfilledBy)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: es.why.viewDocuments }));
    expect(
      await screen.findByRole('dialog', { name: es.why.documentsTitle(followUpCase.patient.name) }),
    ).toBeInTheDocument();
  });

  it('shows "¿Por qué?" on every expectation of the patient page', async () => {
    const followUpCase = caseWith('protocol');
    renderApp(`/patients/${followUpCase.patient.id}`, { locale: 'es' });
    expect((await screen.findAllByRole('button', { name: es.why.button })).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole('button', { name: es.why.viewDocuments })).toBeInTheDocument();
  });
});
