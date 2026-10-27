import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api/client.ts';
import { errorMessage, fieldError } from './components/states.tsx';
import { formatOverdue } from './lib/format.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * QA round 2 of the inbox (HIP-126, HIP-127, HIP-131): each test reproduces
 * one finding through the UI, against the stateful mock API.
 */

/** case-001: María Fernanda Ortiz, live, active, with a doctor's-plan quote. */
const DIABETES_CASE = '/bandeja/case-001';

const PCOS_PATIENT =
  createMockStore()
    .listCases({ view: 'active' })
    .items.find((item) => item.patient.name === 'Ana Lucía Torres')?.patient.id ?? '';

function around(element: Element | undefined, selector: string): HTMLElement {
  const found = element?.closest(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`expected a ${selector} around the element`);
  return found;
}

const NOTE_TOO_LONG = 'La nota puede tener hasta 2000 caracteres.';

describe('HIP-127 validation errors in Spanish, next to the input', () => {
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
    await user.click(await screen.findByRole('button', { name: 'Posponer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    const note = within(dialog).getByLabelText(/Nota interna/);
    await user.type(note, 'Llamar el lunes');
    await user.click(within(dialog).getByRole('button', { name: 'Posponer' }));
    const message = await within(dialog).findByText(NOTE_TOO_LONG);
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAttribute('aria-describedby', message.id);
    expect(within(dialog).getAllByText(NOTE_TOO_LONG)).toHaveLength(1);
    // Editing the note clears the stale message.
    await user.type(note, '.');
    expect(within(dialog).queryByText(NOTE_TOO_LONG)).not.toBeInTheDocument();
  });

  it("never shows the validator's English text, even from an API that sends it", () => {
    const raw = new ApiError(
      422,
      'validation_error',
      'note: Too big: expected string to have <=2000 characters',
    );
    expect(errorMessage(raw)).toBe('Revisa los datos ingresados e intenta de nuevo.');
    const spanish = new ApiError(422, 'invalid_request', 'x', [
      { path: 'q', message: 'La búsqueda puede tener hasta 100 caracteres.' },
    ]);
    expect(errorMessage(spanish)).toBe('La búsqueda puede tener hasta 100 caracteres.');
    expect(fieldError(spanish, 'q')).toBe('La búsqueda puede tener hasta 100 caracteres.');
    expect(fieldError(spanish, 'note')).toBeUndefined();
  });

  it('shows a too long search under the box instead of replacing the list with an error', async () => {
    renderApp('/bandeja?buscar=ana', {
      handlers: () => [
        http.get('*/api/inbox/cases', () =>
          HttpResponse.json(
            {
              error: {
                code: 'invalid_request',
                message: 'La búsqueda puede tener hasta 100 caracteres.',
                fields: [{ path: 'q', message: 'La búsqueda puede tener hasta 100 caracteres.' }],
              },
            },
            { status: 422 },
          ),
        ),
      ],
    });
    const message = await screen.findByText('La búsqueda puede tener hasta 100 caracteres.');
    expect(screen.getByLabelText('Buscar paciente')).toHaveAttribute(
      'aria-describedby',
      message.id,
    );
    expect(screen.queryByText('No pudimos cargar los casos')).not.toBeInTheDocument();
  });

  it('puts the API limits on the inputs, so they are visible while typing', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Posponer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    expect(within(dialog).getByLabelText(/Nota interna/)).toHaveAttribute('maxLength', '2000');
    await user.keyboard('{Escape}');
    expect(screen.getByLabelText('Buscar paciente')).toHaveAttribute('maxLength', '100');
    await user.click(screen.getByRole('button', { name: 'No útil' }));
    expect(screen.getByLabelText('Comentario (opcional)')).toHaveAttribute('maxLength', '2000');
  });

  it('limits the demo patient name and note', async () => {
    renderApp('/demo');
    expect(await screen.findByLabelText('Nombre del paciente nuevo')).toHaveAttribute(
      'maxLength',
      '120',
    );
    expect(screen.getByLabelText('Nota de la consulta')).toHaveAttribute('maxLength', '20000');
  });
});

describe('HIP-126 keyboard focus after a case dialog', () => {
  it.each([
    ['Escape', '{Escape}'],
    ['Cancelar', 'Cancelar'],
    ['the X', 'Cerrar'],
  ])('returns to the button that opened it when closed with %s', async (_, how) => {
    const { user } = renderApp(DIABETES_CASE);
    const trigger = await screen.findByRole('button', { name: 'Posponer' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    if (how.startsWith('{')) await user.keyboard(how);
    else await user.click(within(dialog).getByRole('button', { name: how }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('returns to the trigger after a successful snooze', async () => {
    const { user } = renderApp(DIABETES_CASE);
    const trigger = await screen.findByRole('button', { name: 'Posponer' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    await user.click(within(dialog).getByRole('button', { name: 'Posponer' }));
    await screen.findByText('Caso pospuesto.');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Posponer' })).toHaveFocus();
    });
  });

  it('lands on the closed notice when resolving removes the buttons', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolver el caso' });
    await user.click(within(dialog).getByRole('button', { name: 'Resolver caso' }));
    const notice = await screen.findByText(/Este caso está cerrado/);
    await waitFor(() => {
      expect(around(notice, '[role="status"]')).toHaveFocus();
    });
  });
});

describe('HIP-126 overdue label', () => {
  it('says the deadline passed today, not that it is still due', () => {
    const now = new Date('2026-01-20T12:00:00Z');
    expect(formatOverdue(0, '2026-01-20T08:00:00Z', now)).toBe('Venció hoy');
    expect(formatOverdue(0, '2026-01-20T18:00:00Z', now)).toBe('Vence hoy');
    expect(formatOverdue(1, '2026-01-19T16:13:00Z', now)).toBe('Vencido hace 1 día');
  });
});

describe('HIP-126 escalation of a snoozed case', () => {
  it('dates the pending steps from the end of the snooze, not from the case opening', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Posponer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    await user.click(within(dialog).getByRole('button', { name: '30 días' }));
    await user.click(within(dialog).getByRole('button', { name: 'Posponer' }));
    await screen.findByText('Caso pospuesto.');
    const card = around(await screen.findByRole('heading', { name: 'Escalamiento' }), 'section');
    await waitFor(() => {
      expect(within(card).getByText(/Pospuesto hasta el/)).toBeInTheDocument();
    });
    expect(
      within(card).getAllByText(/^Previsto para el .* si nadie actúa$/).length,
    ).toBeGreaterThan(0);
    expect(card.textContent).not.toMatch(/de abierto el caso/);
  });
});

describe('HIP-131 patients to recover', () => {
  it('says when each held case enters the inbox', async () => {
    renderApp('/por-recuperar');
    const list = around(await screen.findByRole('heading', { name: /en espera/ }), 'section');
    expect(within(list).getAllByText(/^Entra a la bandeja (mañana|hoy|el) /).length).toBe(
      within(list).getAllByRole('listitem').length,
    );
  });

  it('+1 día releases the next batch and says how many entered the inbox', async () => {
    const { user, store } = renderApp('/demo');
    const before = store.listRecovery({}).total;
    expect(before).toBeGreaterThan(0);
    await user.click(await screen.findByRole('button', { name: '+1 día' }));
    const after = store.listRecovery({}).total;
    expect(after).toBeLessThan(before);
    const released = before - after;
    expect(
      await screen.findByText(
        new RegExp(`^Entr(ó|aron) ${String(released)} pacientes? de «Por recuperar» a la bandeja`),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Pasó 1 día/)).toBeInTheDocument();
  });
});

describe('conditions rejected by the clinic system', () => {
  it('says who ruled the condition out', async () => {
    renderApp(`/pacientes/${PCOS_PATIENT}`, {
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
    expect(
      (await screen.findAllByText('Descartada por el sistema del consultorio')).length,
    ).toBeGreaterThan(0);
  });
});
