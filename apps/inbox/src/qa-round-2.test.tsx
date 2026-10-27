import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api/client.ts';
import { errorMessage, fieldError } from './components/states.tsx';
import { messagesFor, setLocale } from './i18n/index.ts';
import { formatOverdue } from './lib/format.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * QA round 2 of the inbox (HIP-126, HIP-127, HIP-131): each test reproduces
 * one finding through the UI, against the stateful mock API.
 */

/** English, the default UI language. */
const t = messagesFor('en');

/** case-001: María Fernanda Ortiz, live, active, with a doctor's-plan quote. */
const DIABETES_CASE = '/inbox/case-001';

const PCOS_PATIENT =
  createMockStore()
    .listCases({ view: 'active' })
    .items.find((item) => item.patient.name === 'Ana Lucía Torres')?.patient.id ?? '';

function around(element: Element | undefined, selector: string): HTMLElement {
  const found = element?.closest(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`expected a ${selector} around the element`);
  return found;
}

const NOTE_TOO_LONG = 'The note can be up to 2,000 characters.';
const SEARCH_TOO_LONG = 'The search can be up to 100 characters.';

describe('HIP-127 validation errors in the UI language, next to the input', () => {
  it('shows the API field message under the note, once, and never the validator text', async () => {
    const { user } = renderApp(DIABETES_CASE, {
      handlers: () => [
        http.post('*/api/inbox/cases/:id/actions', () =>
          HttpResponse.json(
            {
              error: {
                code: 'invalid_request',
                message: NOTE_TOO_LONG,
                fields: [{ path: 'note', message: NOTE_TOO_LONG }],
              },
            },
            { status: 422 },
          ),
        ),
      ],
    });
    await user.click(await screen.findByRole('button', { name: t.caseActions.snooze }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    const note = within(dialog).getByLabelText(t.caseActions.noteOptional);
    await user.type(note, 'Llamar el lunes');
    await user.click(within(dialog).getByRole('button', { name: t.caseActions.snoozeConfirm }));
    const message = await within(dialog).findByText(NOTE_TOO_LONG);
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAttribute('aria-describedby', message.id);
    expect(within(dialog).getAllByText(NOTE_TOO_LONG)).toHaveLength(1);
    // Editing the note clears the stale message.
    await user.type(note, '.');
    expect(within(dialog).queryByText(NOTE_TOO_LONG)).not.toBeInTheDocument();
  });

  it("never shows the validator's raw text, even from an API that sends it", () => {
    const raw = new ApiError(
      422,
      'validation_error',
      'note: Too big: expected string to have <=2000 characters',
    );
    expect(errorMessage(raw)).toBe(t.errors.validationFallback);
    setLocale('es');
    expect(errorMessage(raw)).toBe(messagesFor('es').errors.validationFallback);
    const localized = new ApiError(422, 'invalid_request', 'x', [
      { path: 'q', message: SEARCH_TOO_LONG },
    ]);
    expect(errorMessage(localized)).toBe(SEARCH_TOO_LONG);
    expect(fieldError(localized, 'q')).toBe(SEARCH_TOO_LONG);
    expect(fieldError(localized, 'note')).toBeUndefined();
  });

  it('shows a too long search under the box instead of replacing the list with an error', async () => {
    renderApp('/inbox?q=ana', {
      handlers: () => [
        http.get('*/api/inbox/patients-queue', () =>
          HttpResponse.json(
            {
              error: {
                code: 'invalid_request',
                message: SEARCH_TOO_LONG,
                fields: [{ path: 'q', message: SEARCH_TOO_LONG }],
              },
            },
            { status: 422 },
          ),
        ),
      ],
    });
    const message = await screen.findByText(SEARCH_TOO_LONG);
    expect(screen.getByLabelText(t.inbox.searchLabel)).toHaveAttribute(
      'aria-describedby',
      message.id,
    );
    expect(screen.queryByText(t.inbox.error)).not.toBeInTheDocument();
  });

  it('puts the API limits on the inputs, so they are visible while typing', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: t.caseActions.snooze }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    expect(within(dialog).getByLabelText(t.caseActions.noteOptional)).toHaveAttribute(
      'maxLength',
      '2000',
    );
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText(t.inbox.searchLabel)).toHaveAttribute('maxLength', '100');
    await user.click(screen.getByRole('button', { name: t.feedback.notUseful }));
    expect(screen.getByLabelText(t.feedback.comment)).toHaveAttribute('maxLength', '2000');
  });

  it('limits the demo patient name and note', async () => {
    renderApp('/demo');
    expect(await screen.findByLabelText(t.consultation.newPatientName)).toHaveAttribute(
      'maxLength',
      '120',
    );
    expect(screen.getByLabelText(t.consultation.note)).toHaveAttribute('maxLength', '20000');
  });
});

describe('HIP-126 keyboard focus after a case dialog', () => {
  it.each([
    ['Escape', '{Escape}'],
    ['Cancel', t.common.cancel],
    ['the X', t.common.close],
  ])('returns to the button that opened it when closed with %s', async (_, how) => {
    const { user } = renderApp(DIABETES_CASE);
    const trigger = await screen.findByRole('button', { name: t.caseActions.snooze });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    if (how.startsWith('{')) await user.keyboard(how);
    else await user.click(within(dialog).getByRole('button', { name: how }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('returns to the trigger after a successful snooze', async () => {
    const { user } = renderApp(DIABETES_CASE);
    const trigger = await screen.findByRole('button', { name: t.caseActions.snooze });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    await user.click(within(dialog).getByRole('button', { name: t.caseActions.snoozeConfirm }));
    await screen.findByText(t.caseActions.snoozeDone);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t.caseActions.snooze })).toHaveFocus();
    });
  });

  it('lands on the closed notice when resolving removes the buttons', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: t.caseActions.resolve }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.resolveTitle });
    await user.click(within(dialog).getByRole('button', { name: t.caseActions.resolveConfirm }));
    const notice = await screen.findByText(/This case is closed/);
    await waitFor(() => {
      expect(around(notice, '[role="status"]')).toHaveFocus();
    });
  });
});

describe('HIP-126 overdue label', () => {
  it('says the deadline passed today, not that it is still due', () => {
    const now = new Date('2026-01-20T12:00:00Z');
    expect(formatOverdue(0, '2026-01-20T08:00:00Z', now)).toBe('Was due today');
    expect(formatOverdue(0, '2026-01-20T18:00:00Z', now)).toBe('Due today');
    expect(formatOverdue(1, '2026-01-19T16:13:00Z', now)).toBe('Overdue by 1 day');
    expect(formatOverdue(3, '2026-01-17T16:13:00Z', now)).toBe('Overdue by 3 days');
    setLocale('es');
    expect(formatOverdue(0, '2026-01-20T08:00:00Z', now)).toBe('Venció hoy');
    expect(formatOverdue(0, '2026-01-20T18:00:00Z', now)).toBe('Vence hoy');
    expect(formatOverdue(1, '2026-01-19T16:13:00Z', now)).toBe('Vencido hace 1 día');
  });
});

describe('HIP-126 escalation of a snoozed case', () => {
  it('dates the pending steps from the end of the snooze, not from the case opening', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: t.caseActions.snooze }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.snoozeTitle });
    await user.click(within(dialog).getByRole('button', { name: t.time.days(30) }));
    await user.click(within(dialog).getByRole('button', { name: t.caseActions.snoozeConfirm }));
    await screen.findByText(t.caseActions.snoozeDone);
    const card = around(
      await screen.findByRole('heading', { name: t.caseDetail.escalation }),
      'section',
    );
    await waitFor(() => {
      expect(within(card).getByText(/Snoozed until/)).toBeInTheDocument();
    });
    expect(within(card).getAllByText(/^Planned for .* if nobody acts$/).length).toBeGreaterThan(0);
    expect(card.textContent).not.toMatch(/after the case opened/);
  });
});

describe('HIP-131 patients to recover', () => {
  it('says when each held case enters the inbox', async () => {
    renderApp('/recovery');
    const list = around(await screen.findByRole('heading', { name: /waiting/ }), 'section');
    expect(within(list).getAllByText(/^Enters the inbox (tomorrow|today|on) /).length).toBe(
      within(list).getAllByRole('listitem').length,
    );
  });

  it('+1 day releases the next batch and says how many entered the inbox', async () => {
    const { user, store } = renderApp('/demo');
    const before = store.listRecovery({}).total;
    expect(before).toBeGreaterThan(0);
    await user.click(await screen.findByRole('button', { name: t.demo.daysButton(1) }));
    const after = store.listRecovery({}).total;
    expect(after).toBeLessThan(before);
    const released = before - after;
    expect(
      await screen.findByText(
        new RegExp(`^${String(released)} patients? from “To recover” entered the inbox`),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^1 day passed/)).toBeInTheDocument();
  });
});

describe('conditions rejected by the clinic system', () => {
  it('says who ruled the condition out', async () => {
    renderApp(`/patients/${PCOS_PATIENT}`, {
      handlers: (store) => [
        http.get('*/api/inbox/patients/:id', ({ params }) => {
          const detail = store.getPatient(String(params['id']));
          return HttpResponse.json({
            ...detail,
            conditions: detail.conditions.map((condition) => ({
              ...condition,
              status: 'rejected',
              rejectedBy: 'host',
            })),
          });
        }),
      ],
    });
    expect((await screen.findAllByText(t.patient.rejectedBy.host)).length).toBeGreaterThan(0);
  });
});

describe('QA round 2 merge: patient view', () => {
  it('never shows a condition the clinic system entered in error', async () => {
    renderApp(`/patients/${PCOS_PATIENT}`, {
      handlers: (store) => [
        http.get('*/api/inbox/patients/:id', ({ params }) => {
          const detail = store.getPatient(String(params['id']));
          const [first, ...rest] = detail.conditions;
          return HttpResponse.json({
            ...detail,
            conditions: [
              ...rest,
              ...(first === undefined
                ? []
                : [
                    {
                      ...first,
                      id: 'in-error',
                      display: 'Diagnóstico registrado por error',
                      status: 'entered_in_error',
                    },
                  ]),
            ],
          });
        }),
      ],
    });
    expect(
      await screen.findByRole('heading', { name: new RegExp(t.patient.conditions) }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Diagnóstico registrado por error')).not.toBeInTheDocument();
    expect(screen.queryByText(t.labels.conditionStatuses.entered_in_error)).not.toBeInTheDocument();
  });

  it('says when a note was too long to be read whole', async () => {
    renderApp(`/patients/${PCOS_PATIENT}`, {
      handlers: (store) => [
        http.get('*/api/inbox/patients/:id', ({ params }) => {
          const detail = store.getPatient(String(params['id']));
          return HttpResponse.json({
            ...detail,
            qualityFindings: [
              {
                id: 'note_truncated:doc-1',
                code: 'note_truncated',
                documentId: 'doc-1',
                at: '2026-01-05T15:00:00.000Z',
                label: 'Note read in part',
              },
            ],
          });
        }),
      ],
    });
    expect(await screen.findByText('Note read in part')).toBeInTheDocument();
    expect(screen.getByText(/not the middle/)).toBeInTheDocument();
    expect(
      screen.queryByText(/does not say when the patient should come back/),
    ).not.toBeInTheDocument();
  });
});
