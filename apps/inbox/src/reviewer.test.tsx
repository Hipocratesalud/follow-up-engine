import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './test/render.tsx';

describe('Revisión clínica', () => {
  it('lists shadow findings under the shadow-mode banner, highest severity first', async () => {
    renderApp('/revision-clinica');
    expect(
      await screen.findByText('Modo sombra: el equipo médico no ve estos hallazgos.'),
    ).toBeInTheDocument();
    const rows = await screen.findAllByRole('link', {
      name: /Combinación de riesgo|Creatinina|Cefalea|fondo de ojo/,
    });
    expect(rows.length).toBe(4);
    expect(rows[0]).toHaveTextContent('Alta');
    expect(rows.at(-1)).toHaveTextContent('Media');
    // The live pre-visit question is not in the shadow list.
    expect(screen.queryByText(/hormigueo, ardor/)).not.toBeInTheDocument();
    expect(screen.getByText('Pacientes revisados')).toBeInTheDocument();
    // The nav counts the open shadow findings (desktop and phone navs).
    for (const link of screen.getAllByRole('link', { name: /Revisión clínica/ })) {
      expect(link).toHaveTextContent('4');
    }
  });

  it('shows a trend drawn to scale with its cited results', async () => {
    renderApp('/revision-clinica/cf-001');
    const chart = await screen.findByRole('img', {
      name: /Creatinina: 1,05 → 1,1 → 1,4 → 1,75 mg\/dL/,
    });
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('circle')).toHaveLength(4);
    expect(screen.getAllByTestId('evidence-quote').map((mark) => mark.textContent)).toEqual([
      'Creatinina: 1.1 mg/dL',
      'Creatinina: 1.4 mg/dL',
      'Creatinina: 1.75 mg/dL',
    ]);
    expect(screen.getByText('Sugerencia para el equipo')).toBeInTheDocument();
  });

  it('highlights each quote inside its note and shows the agent trace', async () => {
    const { user } = renderApp('/revision-clinica/cf-003');
    const marks = await screen.findAllByTestId('evidence-quote');
    expect(marks.map((mark) => mark.textContent)).toEqual([
      'Refiere cefalea frontal vespertina de dos semanas',
      'Persiste cefalea, ahora casi diaria, que cede parcialmente con analgésicos',
      'Acude nuevamente por cefalea que la despierta en la noche',
    ]);
    expect(marks[0]?.closest('blockquote')).toHaveTextContent('Alergias: niega.');
    await user.click(screen.getByText('Cómo llegó a esto'));
    expect(screen.getByText('Consultó la tendencia de la creatinina')).toBeVisible();
    expect(screen.getByText('Entregó 2 hallazgos')).toBeVisible();
  });

  it('asks for a reason before marking a finding not relevant, and sends nothing without it', async () => {
    const { user, store } = renderApp('/revision-clinica/cf-002');
    await user.click(await screen.findByRole('button', { name: 'No relevante' }));
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(
      await screen.findByText('Cuéntanos por qué no es relevante: así sabemos qué ajustar.'),
    ).toBeInTheDocument();
    expect(store.reviewer.getFinding('cf-002').status).toBe('open');
    await user.type(screen.getByLabelText('¿Por qué no es relevante?'), 'El AINE ya se suspendió');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(/Calificado como/)).toHaveTextContent('no relevante');
    expect(store.reviewer.getFinding('cf-002').review).toMatchObject({
      verdict: 'not_relevant',
      reason: 'El AINE ya se suspendió',
    });
  });

  it('records a relevant verdict and lets the reviewer change it', async () => {
    const { user, store } = renderApp('/revision-clinica/cf-001');
    await user.click(await screen.findByRole('button', { name: 'Relevante' }));
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(/Calificado como/)).toHaveTextContent('relevante');
    expect(store.reviewer.getFinding('cf-001').status).toBe('relevant');
    await user.click(screen.getByRole('button', { name: 'Cambiar' }));
    expect(screen.getByRole('button', { name: 'Ya lo sabía' })).toBeInTheDocument();
  });

  it('needs who validated a category before it goes live', async () => {
    const { user } = renderApp('/revision-clinica/categorias');
    const heading = await screen.findByRole('heading', { name: /Tendencia de laboratorio/ });
    const row = heading.closest('li');
    if (!row) throw new Error('flag row not found');
    await user.click(within(row).getByRole('button', { name: 'Pasar a en vivo' }));
    await user.click(within(row).getByRole('button', { name: 'Confirmar' }));
    expect(
      within(row).getByText('Indica quién del equipo clínico validó esta categoría.'),
    ).toBeInTheDocument();
    await user.type(
      within(row).getByLabelText('¿Quién del equipo clínico validó esta categoría?'),
      'Dra. Castellanos',
    );
    await user.click(within(row).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => {
      expect(within(row).getByText(/Validada por Dra. Castellanos/)).toBeInTheDocument();
    });
    expect(within(row).getByRole('button', { name: 'Volver a sombra' })).toBeInTheDocument();
    // The reserved category has no switch.
    const reserved = screen.getByRole('heading', { name: 'Pacientes similares' }).closest('li');
    expect(reserved && within(reserved).queryByRole('switch')).toBeNull();
  });

  it('shows only live questions on the patient page', async () => {
    renderApp('/pacientes/pat-001');
    expect(
      await screen.findByRole('heading', { name: /Para preguntar en la próxima consulta/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/hormigueo, ardor o adormecimiento/)).toBeInTheDocument();
    // Shadow findings of the same patient never appear there.
    expect(screen.queryByText(/Creatinina en ascenso/)).not.toBeInTheDocument();
  });

  it('shows no question section when the patient has none', async () => {
    renderApp('/pacientes/pat-002');
    await screen.findAllByText(/José Luis Méndez/);
    expect(
      screen.queryByRole('heading', { name: /Para preguntar en la próxima consulta/ }),
    ).not.toBeInTheDocument();
  });
});
