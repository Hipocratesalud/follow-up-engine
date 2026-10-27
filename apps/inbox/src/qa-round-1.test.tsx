import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { messagesFor } from './i18n/index.ts';
import { mockApiCopy } from './mocks/api-copy.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * QA round 1 of the inbox (HIP-114, HIP-125, HIP-126, HIP-127): each test
 * reproduces one finding through the UI, against the stateful mock API.
 */

/** English, the default UI language. */
const t = messagesFor('en');
const api = mockApiCopy('en');

/** case-001: María Fernanda Ortiz, live, escalated two steps, with a doctor's-plan quote. */
const DIABETES_CASE = '/inbox/case-001';

/** Ana Lucía Torres: one probable condition read from her note. */
const PCOS_PATIENT =
  createMockStore()
    .listCases({ view: 'active' })
    .items.find((item) => item.patient.name === 'Ana Lucía Torres')?.patient.id ?? '';

/** `element.closest(selector)`, or the test fails. */
function around(element: Element | undefined, selector: string): HTMLElement {
  const found = element?.closest(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`expected a ${selector} around the element`);
  return found;
}

function only(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (!element) throw new Error('expected at least one element');
  return element;
}

function rows(): HTMLElement[] {
  return screen.queryAllByRole('link', { name: /Overdue by|Was due today|Due today/ });
}

describe('HIP-114 inbox counts', () => {
  it('shows the total of the view, not the page size, and loads the rest on demand', async () => {
    const { user, store } = renderApp('/inbox', {
      // Pages of 5, so a handful of cases already spans several pages.
      handlers: (mock) => [
        http.get('*/api/inbox/cases', ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get('cursor');
          return HttpResponse.json(
            mock.listCases({ view: 'active', limit: 5, ...(cursor ? { cursor } : {}) }),
          );
        }),
      ],
    });
    const total = store.stats().activeCases;
    const title = await screen.findByRole('heading', {
      name: new RegExp(`${t.inbox.cases} ${String(total)}`),
    });
    expect(title).toBeInTheDocument();
    await waitFor(() => {
      expect(rows()).toHaveLength(5);
    });
    expect(screen.getByText(t.inbox.showing(5, total))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.inbox.loadMore }));
    await waitFor(() => {
      expect(rows()).toHaveLength(10);
    });
  });
});

describe('HIP-125 owner filter and escalation meter', () => {
  it('filters by owner: the options come from the owners endpoint, by id', async () => {
    const { user, store } = renderApp('/inbox');
    const owner = store.listOwners().items.find((item) => item.name.startsWith('Dr'));
    expect(owner).toBeDefined();
    const select = await screen.findByLabelText(t.inbox.ownerLabel);
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: owner?.name ?? '' })).toBeInTheDocument();
    });
    await user.selectOptions(select, owner?.id ?? '');
    await waitFor(() => {
      expect(rows()).toHaveLength(owner?.activeCases ?? -1);
    });
    for (const row of rows()) expect(row).toHaveTextContent(owner?.name ?? '');
  });

  it("names the escalation step from the case's policy, never a step it does not have", async () => {
    renderApp(DIABETES_CASE);
    const title = await screen.findByRole('heading', { name: t.caseDetail.escalation });
    const card = around(title, 'section');
    expect(within(card).getByText(api.escalationSteps.notify_clinic)).toBeInTheDocument();
    expect(within(card).getByText(api.escalationSteps.escalate_to_coordinator)).toBeInTheDocument();
    expect(screen.getAllByText(/step 2 of 4, priority raised/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/treating doctor/i)).not.toBeInTheDocument();
  });
});

describe('HIP-126 finding the demo case', () => {
  it('finds a patient by name (any case, no accents)', async () => {
    const { user } = renderApp('/inbox');
    await screen.findAllByRole('link', { name: /Overdue by/ });
    await user.type(screen.getByLabelText(t.inbox.searchLabel), 'ana lucia');
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(rows()[0]).toHaveTextContent('Ana Lucía Torres');
  });

  it('marks recent live cases as new', async () => {
    const { user } = renderApp('/demo');
    await user.click(
      await screen.findByRole('button', { name: t.consultation.examples['psychology-plan'] ?? '' }),
    );
    await user.click(screen.getByRole('button', { name: t.consultation.save }));
    await screen.findByRole('region', { name: t.extraction.readingOf('Muse Spark') });
    expect(await screen.findByText(t.extraction.noCaseYet)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t.demo.daysButton(7) }));
    const link = await screen.findByRole('link', {
      name: `${t.extraction.viewCase}${t.extraction.viewCaseOf('Diego Hernández')}`,
    });
    await user.click(link);
    const heading = await screen.findByRole('heading', { name: 'Diego Hernández' });
    // Keyboard users land on the case, not on the list.
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    const row = screen.getByRole('link', { name: /Diego Hernández/ });
    expect(within(row).getByText(t.common.newBadge)).toBeInTheDocument();
  });

  it('keeps the last reading when leaving the demo and coming back', async () => {
    const { user } = renderApp('/demo');
    await user.click(
      await screen.findByRole('button', { name: t.consultation.examples['psychology-plan'] ?? '' }),
    );
    await user.click(screen.getByRole('button', { name: t.consultation.save }));
    await screen.findByRole('region', { name: t.extraction.readingOf('Muse Spark') });
    await user.click(only(screen.getAllByRole('link', { name: new RegExp(t.nav.inbox) })));
    await screen.findByRole('heading', { name: t.inbox.title });
    await user.click(only(screen.getAllByRole('link', { name: /Demo/ })));
    expect(
      await screen.findByRole('region', { name: t.extraction.readingOf('Muse Spark') }),
    ).toBeInTheDocument();
  });

  it('offers every patient of the clinic in the demo, with or without a case', async () => {
    renderApp('/demo');
    const select = await screen.findByLabelText(t.consultation.patient);
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'Julia Romero' })).toBeInTheDocument();
    });
  });
});

describe('HIP-126 case actions', () => {
  it('shows the internal note of a snooze in the history', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: t.caseActions.snooze }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    await user.type(within(dialog).getByLabelText(t.caseActions.noteOptional), 'Llamar el lunes');
    await user.click(within(dialog).getByRole('button', { name: t.caseActions.snoozeConfirm }));
    expect(await screen.findByText('Llamar el lunes')).toBeInTheDocument();
  });

  it('sends one request per confirmation: the button is disabled while pending', async () => {
    const { user } = renderApp(DIABETES_CASE, { latencyMs: 150 });
    await user.click(await screen.findByRole('button', { name: t.caseActions.resolve }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.resolveTitle });
    const confirm = within(dialog).getByRole('button', { name: t.caseActions.resolveConfirm });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    expect(await screen.findByText(/This case is closed/)).toBeInTheDocument();
  });

  it('feedback rate copy counts rated cases, not useful ones', async () => {
    renderApp('/inbox');
    expect(await screen.findByText(/^useful, out of \d+ rated cases$/)).toBeInTheDocument();
  });
});

describe('HIP-126 resilience and navigation', () => {
  it('after an outage, retry brings the whole shell back (clock, clinic, demo link)', async () => {
    let down = true;
    const { user } = renderApp('/inbox', {
      handlers: () => [http.all('*/api/*', () => (down ? HttpResponse.error() : undefined))],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: t.common.retry }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('link', { name: /Demo/ })).not.toBeInTheDocument();
    down = false;
    await user.click(only(screen.getAllByRole('button', { name: t.common.retry })));
    expect((await screen.findAllByRole('link', { name: /Demo/ })).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Centro Médico Los Álamos')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.nav.simulatedDate).length).toBeGreaterThan(0);
  });

  it('a missing patient says so, offers the way back and no useless retry', async () => {
    renderApp('/patients/pat-9999');
    expect(
      await screen.findByRole('heading', { level: 1, name: t.patient.notFound }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.common.goToInbox })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.common.retry })).not.toBeInTheDocument();
  });

  it('a missing case too', async () => {
    renderApp('/cases/does-not-exist');
    expect(await screen.findByText(t.caseDetail.notFound)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.common.retry })).not.toBeInTheDocument();
  });
});

describe('rejected conditions', () => {
  it('moves a rejected condition to a collapsed "Ruled out" group', async () => {
    const { user } = renderApp(`/patients/${PCOS_PATIENT}`);
    const pcos = api.conditionNames['E28.2'] ?? '';
    const condition = around(await screen.findByText(pcos), 'li');
    await user.click(within(condition).getByRole('button', { name: t.patient.reject }));
    const group = await waitFor(() => {
      const summary = screen.getByText(t.patient.ruledOut(1));
      return around(summary, 'details');
    });
    expect(within(group).getByText(pcos)).toBeInTheDocument();
    expect(within(group).getByText(t.labels.conditionStatuses.rejected)).toBeInTheDocument();
    expect(within(group).queryByText(/confidence/)).not.toBeInTheDocument();
  });
});

describe('HIP-127 copy', () => {
  it('agrees in number when one condition is probable', async () => {
    renderApp(`/patients/${PCOS_PATIENT}`);
    expect(await screen.findByText(t.patient.probableOne)).toBeInTheDocument();
  });

  it('never shows internal rule ids in the case history', async () => {
    renderApp(DIABETES_CASE);
    const history = around(
      await screen.findByRole('heading', { name: t.caseDetail.history }),
      'section',
    );
    expect(history.textContent).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
