import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/** case-001 is the seeded diabetes patient with a doctor's-plan reason quoted from her note. */
const DIABETES_CASE = '/bandeja/case-001';

function first(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (!element) throw new Error('expected at least one element');
  return element;
}

describe('inbox', () => {
  it('lists active cases ordered by priority, with layer chips and stats', async () => {
    renderApp('/bandeja');
    const rows = await screen.findAllByRole('link', { name: /Vencido hace/ });
    expect(rows.length).toBeGreaterThan(10);
    expect(within(first(rows)).getByText('Urgente')).toBeInTheDocument();
    expect(screen.getAllByText('Plan del médico').length).toBeGreaterThan(0);
    expect(await screen.findByText('Costo de IA del mes')).toBeInTheDocument();
    expect(screen.getByText(/Muse Spark · Meta/)).toBeInTheDocument();
    // The clinic name comes from GET /api/inbox/clinic, not from the bundle.
    expect((await screen.findAllByText('Centro Médico Los Álamos')).length).toBeGreaterThan(0);
  });

  it('cites the doctor verbatim: the quote is highlighted inside the note excerpt', async () => {
    renderApp(DIABETES_CASE);
    const marks = await screen.findAllByTestId('evidence-quote');
    const mark = first(marks);
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveTextContent('control en 3 meses con HbA1c y perfil lipídico');

    const excerpt = mark.closest('blockquote');
    expect(excerpt).toHaveTextContent(
      /Paciente femenina de 58 años con DM2.*Plan: control en 3 meses/,
    );
    expect(screen.getAllByText('Cita textual de la nota').length).toBe(marks.length);
  });

  it('resolving a case updates its status and removes it from the active list', async () => {
    const { user } = renderApp(DIABETES_CASE);
    const resolve = await screen.findByRole('button', { name: 'Resolver' });
    await user.click(resolve);

    const dialog = await screen.findByRole('dialog', { name: 'Resolver el caso' });
    await user.type(within(dialog).getByLabelText(/Nota interna/), 'Trajo el resultado');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver caso' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/Este caso está cerrado/)).toBeInTheDocument();
    expect(screen.getByText('Resuelto: Trajo el resultado')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /María Fernanda Ortiz/ })).not.toBeInTheDocument();
    });
  });

  it('never sends a diagnosis in the patient message preview', async () => {
    const { user } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Pedir contacto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pedir contacto con el paciente' });
    const preview = within(dialog).getByText(/^Hola, María\./);
    expect(preview.textContent).not.toMatch(/diabetes|DM2|HbA1c|lipídico/i);

    await user.click(within(dialog).getByRole('button', { name: 'Pedir contacto' }));
    expect(await screen.findByText(/le pedimos al sistema del consultorio/)).toBeInTheDocument();
    expect(screen.getAllByText('Avisado').length).toBeGreaterThan(0);
  });

  it('explains instead of contacting a patient who opted out', async () => {
    const { user, store } = renderApp('/bandeja');
    const optedOut = store
      .listCases({ view: 'active' })
      .items.find((item) => item.patientContact.optedOut);
    await user.click(
      await screen.findByRole('link', { name: new RegExp(optedOut?.patient.name ?? '') }),
    );
    await user.click(await screen.findByRole('button', { name: 'Pedir contacto' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/no acepta mensajes del consultorio/)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Pedir contacto' }),
    ).not.toBeInTheDocument();
  });
});

describe('feedback', () => {
  it('requires a reason when the case was not useful', async () => {
    const { user, store } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'No útil' }));
    await user.click(screen.getByRole('button', { name: 'Enviar comentario' }));

    expect(await screen.findByText(/Elige un motivo para continuar/)).toBeInTheDocument();
    expect(store.getCase('case-001').feedback).toBeUndefined();

    await user.click(screen.getByLabelText('El plazo no es el correcto'));
    await user.type(screen.getByLabelText(/Comentario/), 'Era control semestral');
    await user.click(screen.getByRole('button', { name: 'Enviar comentario' }));

    expect(await screen.findByText(/Marcaste este caso como no útil/)).toBeInTheDocument();
    expect(store.getCase('case-001').feedback).toEqual({
      useful: false,
      reason: 'wrong_interval',
      comment: 'Era control semestral',
    });
  });

  it('records a useful verdict in one click', async () => {
    const { user, store } = renderApp(DIABETES_CASE);
    await user.click(await screen.findByRole('button', { name: 'Útil' }));
    expect(await screen.findByText('Marcaste este caso como útil.')).toBeInTheDocument();
    expect(store.getCase('case-001').feedback).toEqual({ useful: true });
  });
});

describe('patient', () => {
  it('confirms a probable condition extracted by the AI, with its evidence', async () => {
    const patientId = createMockStore()
      .listCases({ view: 'active' })
      .items.find((item) => item.patient.name === 'Ana Lucía Torres')?.patient.id;
    const { user } = renderApp(`/pacientes/${patientId ?? ''}`);
    const condition = (await screen.findByText('Síndrome de ovario poliquístico')).closest(
      'li',
    ) as HTMLElement;
    expect(
      within(condition).getByText('Se sospecha síndrome de ovario poliquístico'),
    ).toBeInTheDocument();
    expect(within(condition).getByText('Probable')).toBeInTheDocument();

    await user.click(within(condition).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => {
      expect(within(condition).getByText('Confirmada')).toBeInTheDocument();
    });
  });
});

describe('demo', () => {
  it('runs a consultation end to end: extraction, expectations, clock and the new case', async () => {
    const { user } = renderApp('/demo');
    await user.click(await screen.findByRole('button', { name: /Psicología con sesiones/ }));
    await user.click(screen.getByRole('button', { name: 'Guardar consulta' }));

    const result = await screen.findByRole('region', { name: /Lectura de Muse Spark/ });
    expect(within(result).getByText('muse-spark')).toBeInTheDocument();
    expect(
      within(result).getAllByText('sesiones semanales durante 10 semanas').length,
    ).toBeGreaterThan(0);
    expect(
      within(result).getByText('Sesión de seguimiento indicada en la nota'),
    ).toBeInTheDocument();
    expect(within(result).getByText('Trastorno de pánico')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+30 días' }));
    expect(await screen.findByText(/Pasaron 30 días/)).toBeInTheDocument();
    expect((await screen.findAllByText(/26 nov 2026/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Caso escalado')).length).toBeGreaterThan(0);

    await user.click(first(screen.getAllByRole('link', { name: /Bandeja/ })));
    await user.click(await screen.findByRole('link', { name: /Diego Hernández/ }));
    const quotes = await screen.findAllByTestId('evidence-quote');
    expect(quotes.map((quote) => quote.textContent)).toContain(
      'sesiones semanales durante 10 semanas',
    );
  });

  it('validates the consultation form on submit instead of disabling it', async () => {
    const { user } = renderApp('/demo');
    await user.click(await screen.findByRole('button', { name: 'Guardar consulta' }));
    expect(await screen.findByText(/Escribe el nombre del paciente/)).toBeInTheDocument();
    expect(screen.getByText(/Escribe la nota de la consulta/)).toBeInTheDocument();
  });
});

describe('recovery', () => {
  it('lists backfill patients waiting to be released and says they are not notifications', async () => {
    renderApp('/por-recuperar');
    expect(await screen.findByText('No son notificaciones.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Mercedes Rangel/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Entra a la bandeja el/).length).toBe(6);
  });
});
