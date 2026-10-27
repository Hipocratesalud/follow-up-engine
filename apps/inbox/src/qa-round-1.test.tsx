import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * QA round 1 of the inbox (HIP-114, HIP-125, HIP-126, HIP-127): each test
 * reproduces one finding through the UI, against the stateful mock API.
 */

/** case-001: María Fernanda Ortiz, live, escalated two steps, with a doctor's-plan quote. */
const DIABETES_CASE = '/bandeja/case-001';

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
  return screen.queryAllByRole('link', { name: /Vencido hace|Venció hoy|Vence hoy/ });
}

describe('HIP-114 inbox counts', () => {
  it('shows the total of the view, not the page size, and loads the rest on demand', async () => {
    const { user, store } = renderApp('/bandeja', {
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
      name: new RegExp(`Casos ${String(total)}`),
    });
    expect(title).toBeInTheDocument();
    await waitFor(() => {
      expect(rows()).toHaveLength(5);
    });
    expect(screen.getByText(`Mostrando 5 de ${String(total)} casos`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cargar más casos' }));
    await waitFor(() => {
      expect(rows()).toHaveLength(10);
    });
  });
});

describe('HIP-125 owner filter and escalation meter', () => {
  it('filters by owner: the options come from the owners endpoint, by id', async () => {
    const { user, store } = renderApp('/bandeja');
    const owner = store.listOwners().items.find((item) => item.name.startsWith('Dr'));
    expect(owner).toBeDefined();
    const select = await screen.findByLabelText('Responsable');
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
    const title = await screen.findByRole('heading', { name: 'Escalamiento' });
    const card = around(title, 'section');
    expect(within(card).getByText('Aviso al responsable')).toBeInTheDocument();
    expect(within(card).getByText('Paso a coordinación')).toBeInTheDocument();
    expect(screen.getAllByText(/paso 2 de 4, aumento de prioridad/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Médico tratante/i)).not.toBeInTheDocument();
  });
});

describe('HIP-126 finding the demo case', () => {
  it('finds a patient by name (any case, no accents)', async () => {
    const { user } = renderApp('/bandeja');
    await screen.findAllByRole('link', { name: /Vencido hace/ });
    await user.type(screen.getByLabelText('Buscar paciente'), 'ana lucia');
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(rows()[0]).toHaveTextContent('Ana Lucía Torres');
  });

  it('marks recent live cases as new', async () => {
    const { user } = renderApp('/demo');
    await user.click(await screen.findByRole('button', { name: /Psicología con sesiones/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar consulta' }));
    await screen.findByRole('region', { name: /Lectura de Muse Spark/ });
    expect(
      await screen.findByText(/Aún no hay un caso abierto para este paciente/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+7 días' }));
    const link = await screen.findByRole('link', { name: /Ver caso de Diego Hernández/ });
    await user.click(link);
    const heading = await screen.findByRole('heading', { name: 'Diego Hernández' });
    // Keyboard users land on the case, not on the list.
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    const row = screen.getByRole('link', { name: /Diego Hernández/ });
    expect(within(row).getByText('Nuevo')).toBeInTheDocument();
  });

  it('keeps the last reading when leaving the demo and coming back', async () => {
    const { user } = renderApp('/demo');
    await user.click(await screen.findByRole('button', { name: /Psicología con sesiones/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar consulta' }));
    await screen.findByRole('region', { name: /Lectura de Muse Spark/ });
    await user.click(only(screen.getAllByRole('link', { name: /Bandeja/ })));
    await screen.findByRole('heading', { name: 'Bandeja de seguimiento' });
    await user.click(only(screen.getAllByRole('link', { name: /Demo/ })));
    expect(
      await screen.findByRole('region', { name: /Lectura de Muse Spark/ }),
    ).toBeInTheDocument();
  });

  it('offers every patient of the clinic in the demo, with or without a case', async () => {
    renderApp('/demo');
    const select = await screen.findByLabelText('Paciente');
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'Julia Romero' })).toBeInTheDocument();
    });
  });
});

describe('HIP-126 case actions', () => {
  it('shows the internal note of a snooze in the history', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Posponer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Posponer el caso' });
    await user.type(within(dialog).getByLabelText(/Nota interna/), 'Llamar el lunes');
    await user.click(within(dialog).getByRole('button', { name: 'Posponer' }));
    expect(await screen.findByText('Llamar el lunes')).toBeInTheDocument();
  });

  it('sends one request per confirmation: the button is disabled while pending', async () => {
    const { user } = renderApp(DIABETES_CASE, { latencyMs: 150 });
    await user.click(await screen.findByRole('button', { name: 'Resolver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolver el caso' });
    const confirm = within(dialog).getByRole('button', { name: 'Resolver caso' });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    expect(await screen.findByText(/Este caso está cerrado/)).toBeInTheDocument();
  });

  it('feedback rate copy counts rated cases, not useful ones', async () => {
    renderApp('/bandeja');
    expect(await screen.findByText(/^útiles, de \d+ casos calificados$/)).toBeInTheDocument();
  });
});

describe('HIP-126 resilience and navigation', () => {
  it('after an outage, retry brings the whole shell back (clock, clinic, demo link)', async () => {
    let down = true;
    const { user } = renderApp('/bandeja', {
      handlers: () => [http.all('*/api/*', () => (down ? HttpResponse.error() : undefined))],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Reintentar' }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('link', { name: /Demo/ })).not.toBeInTheDocument();
    down = false;
    await user.click(only(screen.getAllByRole('button', { name: 'Reintentar' })));
    expect((await screen.findAllByRole('link', { name: /Demo/ })).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Centro Médico Los Álamos')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fecha simulada/).length).toBeGreaterThan(0);
  });

  it('a missing patient says so, offers the way back and no useless retry', async () => {
    renderApp('/pacientes/pat-9999');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No encontramos ese paciente' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a la bandeja' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('a missing case too', async () => {
    renderApp('/casos/does-not-exist');
    expect(await screen.findByText('No encontramos ese caso')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });
});

describe('rejected conditions', () => {
  it('moves a rejected condition to a collapsed "Descartadas" group', async () => {
    const { user } = renderApp(`/pacientes/${PCOS_PATIENT}`);
    const condition = around(await screen.findByText('Síndrome de ovario poliquístico'), 'li');
    await user.click(within(condition).getByRole('button', { name: 'Descartar' }));
    const group = await waitFor(() => {
      const summary = screen.getByText(/^Descartadas \(1\)$/);
      return around(summary, 'details');
    });
    expect(within(group).getByText('Síndrome de ovario poliquístico')).toBeInTheDocument();
    expect(within(group).getByText('Descartada')).toBeInTheDocument();
    expect(within(group).queryByText(/de confianza/)).not.toBeInTheDocument();
  });
});

describe('HIP-127 copy', () => {
  it('agrees in number when one condition is probable', async () => {
    renderApp(`/pacientes/${PCOS_PATIENT}`);
    expect(
      await screen.findByText(
        'Hay una condición probable leída de las notas. Revísala: mientras no la confirmes, nadie contacta al paciente por ella.',
      ),
    ).toBeInTheDocument();
  });

  it('never shows internal rule ids in the case history', async () => {
    renderApp(DIABETES_CASE);
    const history = around(
      await screen.findByRole('heading', { name: 'Historial del caso' }),
      'section',
    );
    expect(history.textContent).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
