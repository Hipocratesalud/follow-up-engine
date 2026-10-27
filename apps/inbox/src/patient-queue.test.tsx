import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockStore, type MockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-141 in the inbox: one card per patient with every case grouped, actions
 * per case, one contact request for the patient, and the one-click review of
 * the plan items the AI read.
 */

const PATIENT_NAME = 'Elena Cola Ruiz';

/**
 * A new patient whose note asks for a control in two weeks, with an HbA1c
 * ordered; 22 days later both are overdue: a follow-up case and a pending
 * results case. Returns the patient id.
 */
function twoCases(store: MockStore): string {
  store.createConsultation({
    specialty: 'internal_medicine',
    patientName: PATIENT_NAME,
    noteText: 'Paciente estable, sin cambios. Se solicita HbA1c. Control en 2 semanas.',
    orders: [{ loinc: '4548-4', display: 'HbA1c' }],
  });
  store.advance(22);
  return store.listPatients(PATIENT_NAME).items[0]?.id ?? 'missing';
}

function setUp(): void {
  renderApp('/bandeja', {
    handlers: (store) => {
      twoCases(store);
      return [];
    },
  });
}

async function openCard() {
  const rendered = renderApp('/bandeja', {
    handlers: (store) => {
      twoCases(store);
      return [];
    },
  });
  const card = await screen.findByRole('link', { name: new RegExp(PATIENT_NAME) });
  await rendered.user.click(card);
  await screen.findByRole('heading', { name: PATIENT_NAME, level: 2 });
  return rendered;
}

describe('HIP-141 one card per patient', () => {
  it('shows one card for a patient with two cases, with every reason and layer', async () => {
    setUp();
    const card = await screen.findByRole('link', { name: new RegExp(PATIENT_NAME) });
    expect(screen.getAllByRole('link', { name: new RegExp(PATIENT_NAME) })).toHaveLength(1);
    expect(within(card).getByText('2 cases')).toBeInTheDocument();
    expect(within(card).getByText('+1 reason')).toBeInTheDocument();
  });

  it('opens the patient with each case as a section, actions per case, contact once', async () => {
    const { user, store } = await openCard();
    const cases = screen.getByRole('heading', { name: /^Cases/ }).closest('section');
    if (!(cases instanceof HTMLElement)) throw new Error('expected the cases section');
    const rows = within(cases).getAllByRole('link');
    expect(rows).toHaveLength(2);
    // The open case shows its own actions, never a per-case contact request.
    expect(screen.getByRole('button', { name: 'Posponer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir contacto' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Request contact' })).toHaveLength(1);

    // Opening the other case keeps the card and shows that case's detail.
    const other = rows.find((row) => row.getAttribute('aria-current') !== 'true');
    if (other === undefined) throw new Error('expected a second case');
    const href = other.getAttribute('href');
    await user.click(other);
    await waitFor(() => {
      const opened = screen.getAllByRole('link').find((link) => link.getAttribute('href') === href);
      expect(opened).toHaveAttribute('aria-current', 'true');
    });

    // One request for the patient: both cases are notified.
    await user.click(screen.getByRole('button', { name: 'Request contact' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request contact with the patient' });
    expect(within(dialog).getByText(/once for their 2 cases/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Request contact' }));
    expect(
      await screen.findByText(/the clinic system will contact the patient/),
    ).toBeInTheDocument();
    const patientId = store.listPatientQueue({ q: PATIENT_NAME }).items[0]?.patient.id ?? 'missing';
    expect(store.getPatientCard(patientId).cases.map((view) => view.status)).toEqual([
      'notified',
      'notified',
    ]);
    // Within the window the patient cannot be asked again, from any case.
    await user.click(screen.getByRole('button', { name: 'Request contact' }));
    const again = await screen.findByRole('dialog', { name: 'Request contact with the patient' });
    await user.click(within(again).getByRole('button', { name: 'Request contact' }));
    expect(await within(again).findByText(/hace pocos días/)).toBeInTheDocument();
  });

  it('counts patients first and cases second in the list', async () => {
    const { store } = renderApp('/bandeja');
    const { activePatients, activeCases } = store.stats();
    expect(
      await screen.findByText(
        `Showing ${String(activePatients)} of ${String(activePatients)} patients · ${String(activeCases)} cases`,
      ),
    ).toBeInTheDocument();
  });
});

describe('HIP-141 plan item review', () => {
  async function planReason() {
    const rendered = await openCard();
    const cases = screen.getByRole('heading', { name: /^Cases/ }).closest('section');
    if (!(cases instanceof HTMLElement)) throw new Error('expected the cases section');
    // Open the follow-up case (the doctor's plan item).
    const plan = within(cases)
      .getAllByRole('link')
      .find((row) => row.textContent.includes('Consulta de control'));
    if (plan === undefined) throw new Error('expected the plan case');
    await rendered.user.click(plan);
    await screen.findByText('Not reviewed yet');
    return rendered;
  }

  it('confirms a plan item in one click', async () => {
    const { user } = await planReason();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/^Confirmed by /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('validates a correction on click, then corrects the kind', async () => {
    const { user } = await planReason();
    await user.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct the plan item' });
    const save = within(dialog).getByRole('button', { name: 'Save correction' });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(
      within(dialog).getByText('Change the due date or what it asks for to correct the item.'),
    ).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('What it asks for'), 'lab');
    await user.click(save);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/^Corrected by /)).toBeInTheDocument();
  });

  it('rejects a plan item and resolves the case it was the only reason of', async () => {
    const { user } = await planReason();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject the plan item' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject item' }));
    expect(await screen.findByText(/Este caso está cerrado/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Closed cases/ })).toBeInTheDocument();
  });

  it('shows the review on the patient page too', async () => {
    // Ids are deterministic: a fresh store mints the same patient id.
    const patientId = twoCases(createMockStore());
    const { user } = renderApp(`/pacientes/${patientId}`, {
      handlers: (store) => {
        twoCases(store);
        return [];
      },
    });
    await screen.findByRole('heading', { name: PATIENT_NAME, level: 1 });
    expect(screen.getByText('Not reviewed yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/^Confirmed by /)).toBeInTheDocument();
  });
});
