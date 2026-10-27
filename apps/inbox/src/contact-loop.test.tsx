import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockStore, MockHttpError } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-136: the patient-contact loop and dismissals that stick, through the
 * UI against the mock API (same contract as apps/api).
 */

/** The seeded case of a patient, by name (case ids follow the seed order). */
function caseOf(name: string, view: 'active' | 'closed' = 'active'): string {
  const found = createMockStore()
    .listCases({ view, limit: 200 })
    .items.find((item) => item.patient.name === name);
  if (!found) throw new Error(`no seeded case for ${name}`);
  return found.id;
}

function patientOf(name: string): string {
  const found = createMockStore()
    .listPatients(name)
    .items.find((item) => item.name === name);
  if (!found) throw new Error(`no seeded patient ${name}`);
  return found.id;
}

async function openDismissDialog(caseId: string) {
  const rendered = renderApp(`/bandeja/${caseId}`);
  await rendered.user.click(await screen.findByRole('button', { name: 'Descartar' }));
  const dialog = await screen.findByRole('dialog', { name: 'Descartar el caso' });
  return { ...rendered, dialog };
}

describe('dismiss dialog', () => {
  it('asks for a reason on click, and a note for "Otro motivo", never disabling the button', async () => {
    const caseId = caseOf('José Luis Méndez');
    const { user, dialog, store } = await openDismissDialog(caseId);
    const confirm = within(dialog).getByRole('button', { name: 'Descartar caso' });
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Elige por qué descartas el caso.');
    expect(store.getCase(caseId).status).not.toBe('dismissed');

    await user.click(within(dialog).getByRole('radio', { name: /Otro motivo/ }));
    expect(within(dialog).queryByText('Elige por qué descartas el caso.')).not.toBeInTheDocument();
    await user.click(confirm);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Cuéntanos el motivo en la nota.');

    await user.type(within(dialog).getByLabelText('Nota interna'), 'Duplicado de otro caso');
    await user.click(confirm);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(store.getCase(caseId).dismissal).toMatchObject({
      reason: 'other',
      note: 'Duplicado de otro caso',
    });
    expect(await screen.findByRole('heading', { name: 'Por qué se descartó' })).toBeInTheDocument();
    // The verdict is the dismissal reason: no separate "¿Te sirvió?" on a dismissed case.
    expect(screen.queryByText('¿Te sirvió este caso?')).not.toBeInTheDocument();
  });

  it('"No aplica a este paciente" can stop the protocol and visit-pattern reminders for this patient only', async () => {
    const caseId = caseOf('Luis Alberto Herrera');
    const { user, dialog, store } = await openDismissDialog(caseId);
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /No aplica a este paciente/ }));
    const checkbox = within(dialog).getByRole('checkbox', {
      name: /Dejar de recordarlo para este paciente/,
    });
    // The checkbox names which reminders it stops.
    expect(checkbox).toHaveAccessibleDescription(
      /Deja de recordar:.*Sin consulta de diabetología en 5 meses.*Fondo de ojo anual pendiente/,
    );
    await user.click(checkbox);
    await user.click(within(dialog).getByRole('button', { name: 'Descartar caso' }));

    const summary = await screen.findByRole('region', { name: 'Por qué se descartó' });
    expect(within(summary).getByText('Dejó de recordarse para este paciente')).toBeInTheDocument();
    const patientId = store.getCase(caseId).patient.id;
    const suppressions = store.getPatient(patientId).suppressions;
    expect(suppressions.map((item) => item.ruleId).sort()).toEqual([
      'cadence_diabetology_visit',
      'protocol_diabetes_fundus',
    ]);
    expect(suppressions.every((item) => item.active)).toBe(true);
  });

  it('what a clinician asked for is never stopped for the patient: no checkbox, only this case', async () => {
    const { user, dialog } = await openDismissDialog(caseOf('José Luis Méndez'));
    await user.click(within(dialog).getByRole('radio', { name: /No aplica a este paciente/ }));
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /no se puede desactivar para el paciente: solo se descarta este caso/,
      ),
    ).toBeInTheDocument();
  });

  it('a case with both kinds says which reminders stay active', async () => {
    const store = createMockStore();
    const mixed = store
      .listCases({ view: 'active', limit: 200 })
      .items.find(
        (item) =>
          item.reasons.some((reason) => reason.suppressible) &&
          item.reasons.some((reason) => !reason.suppressible),
      );
    if (!mixed) throw new Error('expected a seeded case with both kinds of reasons');
    const { user, dialog } = await openDismissDialog(mixed.id);
    await user.click(within(dialog).getByRole('radio', { name: /No aplica a este paciente/ }));
    expect(within(dialog).getByRole('checkbox')).toHaveAccessibleDescription(
      /sigue activo para el paciente/,
    );
  });

  it('"El diagnóstico no es correcto" points to the patient page to reject the condition', async () => {
    const { user, dialog } = await openDismissDialog(caseOf('José Luis Méndez'));
    await user.click(within(dialog).getByRole('radio', { name: /El diagnóstico no es correcto/ }));
    expect(within(dialog).getByRole('link', { name: 'ficha del paciente' })).toHaveAttribute(
      'href',
      `/pacientes/${patientOf('José Luis Méndez')}`,
    );
  });

  it('the mock API mirrors the 422s of the real one', () => {
    const store = createMockStore();
    const caseId = caseOf('José Luis Méndez');
    for (const [request, path] of [
      [{ action: 'dismiss' }, 'reason'],
      [{ action: 'dismiss', reason: 'other' }, 'note'],
      [{ action: 'dismiss', reason: 'already_done', suppress: true }, 'suppress'],
      // Nothing of this case can be stopped for the patient (a plan and a result).
      [{ action: 'dismiss', reason: 'not_applicable_to_patient', suppress: true }, 'suppress'],
    ] as const) {
      try {
        store.act(caseId, request);
        throw new Error('expected a 422');
      } catch (error) {
        expect(error).toBeInstanceOf(MockHttpError);
        expect(error).toMatchObject({ status: 422, fields: [{ path }] });
      }
    }
  });
});

describe('contact with the patient', () => {
  it('shows every attempt with its channel and outcome, and the call task records an outcome', async () => {
    const caseId = caseOf('Rosa Inés Montilla');
    const { user, store } = renderApp(`/bandeja/${caseId}`);
    const timeline = await screen.findByRole('region', { name: /Contacto con el paciente/ });
    expect(within(timeline).getByText('Intento 1 · WhatsApp')).toBeInTheDocument();
    expect(within(timeline).getByText('Sin respuesta')).toBeInTheDocument();
    expect(within(timeline).getByText('Intento 2 · Llamada')).toBeInTheDocument();
    expect(within(timeline).getByText('Llamada pendiente')).toBeInTheDocument();

    const task = screen.getByRole('region', { name: 'Llamar al paciente' });
    const outcomes = within(task)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(outcomes).toEqual([
      'Contestó y agendó',
      'Contestó, se atiende en otro lado',
      'No contestó',
      'Número equivocado',
      'No quiere seguimiento',
    ]);
    await user.click(within(task).getByRole('button', { name: 'Contestó y agendó' }));

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Llamar al paciente' })).not.toBeInTheDocument();
    });
    expect(within(timeline).getByText('Agendó cita')).toBeInTheDocument();
    expect(store.getCase(caseId).contactAttempts[1]).toMatchObject({
      status: 'answered',
      outcome: 'booked',
    });
  });

  it('a wrong number flags the contact data (warning) and the call came forward', async () => {
    renderApp(`/bandeja/${caseOf('Luis Alberto Herrera')}`);
    expect(
      await screen.findByText(/el teléfono registrado no es del paciente/),
    ).toBeInTheDocument();
    const task = screen.getByRole('region', { name: 'Llamar al paciente' });
    expect(
      within(task).getByText(/llama a Luis Alberto Herrera y confirma su teléfono/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Adelantada por un número equivocado/)).toBeInTheDocument();
  });

  it('"No quiere seguimiento" on the call closes the case', async () => {
    const caseId = caseOf('Rosa Inés Montilla');
    const { user, store } = renderApp(`/bandeja/${caseId}`);
    const task = await screen.findByRole('region', { name: 'Llamar al paciente' });
    await user.click(within(task).getByRole('button', { name: 'No quiere seguimiento' }));
    expect(await screen.findByText(/Este caso está cerrado/)).toBeInTheDocument();
    expect(store.getCase(caseId).status).toBe('resolved');
  });
});

describe('reminders stopped for a patient', () => {
  it('lists them on the patient page and "Volver a activar" turns one back on', async () => {
    const patientId = patientOf('Ricardo Peña');
    const { user, store } = renderApp(`/pacientes/${patientId}`);
    const section = await screen.findByRole('region', { name: /Recordatorios desactivados/ });
    expect(
      within(section).getByText('Sin consulta de diabetología en 4 meses'),
    ).toBeInTheDocument();
    expect(within(section).getByText(/^No aplica a este paciente ·/)).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Volver a activar' }));
    await waitFor(() => {
      expect(
        within(section).queryByRole('button', { name: 'Volver a activar' }),
      ).not.toBeInTheDocument();
    });
    expect(within(section).getByText('Ningún recordatorio desactivado.')).toBeInTheDocument();
    expect(within(section).getByText('Reactivados (1)')).toBeInTheDocument();
    expect(store.getPatient(patientId).suppressions[0]).toMatchObject({ active: false });
  });
});
