import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale, messagesFor } from './i18n/index.ts';
import { mockApiCopy } from './mocks/api-copy.ts';
import { LAYER_LABELS } from './mocks/patient-queue.ts';
import { mockProtocolCatalog } from './mocks/seed.ts';
import { createMockStore, type MockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-141 in the inbox: one card per patient with every case grouped, actions
 * per case, one contact request for the patient, and the one-click review of
 * the plan items the AI read. In both UI languages.
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

function withTwoCases(store: MockStore): [] {
  twoCases(store);
  return [];
}

function casesSection(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: new RegExp(`^${title}`) });
  const section = heading.closest('section');
  if (!(section instanceof HTMLElement)) throw new Error('expected the cases section');
  return section;
}

/** "Confirmed by …" whoever confirmed it. */
function startingWith(text: string): RegExp {
  return new RegExp(`^${text}`);
}

describe.each(LOCALES)('HIP-141 in %s', (locale: Locale) => {
  const t = messagesFor(locale);
  const api = mockApiCopy(locale);

  async function openCard() {
    const rendered = renderApp('/inbox', { locale, handlers: withTwoCases });
    const card = await screen.findByRole('link', { name: new RegExp(PATIENT_NAME) });
    await rendered.user.click(card);
    await screen.findByRole('heading', { name: PATIENT_NAME, level: 2 });
    return rendered;
  }

  /** Opens the follow-up case (the doctor's plan item) of the card. */
  async function planReason() {
    const rendered = await openCard();
    const plan = within(casesSection(t.patientCard.casesTitle))
      .getAllByRole('link')
      .find((row) => row.textContent.includes(api.demo.plan.follow_up_visit));
    if (plan === undefined) throw new Error('expected the plan case');
    await rendered.user.click(plan);
    await screen.findByText(t.planReview.pending);
    return rendered;
  }

  describe('one card per patient', () => {
    it('shows one card for a patient with two cases, with every reason', async () => {
      renderApp('/inbox', { locale, handlers: withTwoCases });
      const card = await screen.findByRole('link', { name: new RegExp(PATIENT_NAME) });
      expect(screen.getAllByRole('link', { name: new RegExp(PATIENT_NAME) })).toHaveLength(1);
      expect(within(card).getByText(t.patientCard.cases(2))).toBeInTheDocument();
      expect(within(card).getByText(t.caseRow.moreReasons(1))).toBeInTheDocument();
    });

    it('opens the patient with each case as a section, actions per case, contact once', async () => {
      const { user, store } = await openCard();
      const rows = within(casesSection(t.patientCard.casesTitle)).getAllByRole('link');
      expect(rows).toHaveLength(2);
      // The open case keeps its own actions, never a per-case contact request.
      expect(screen.getByRole('button', { name: t.caseActions.snooze })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: t.patientCard.requestContact })).toHaveLength(1);
      if (t.caseActions.notify !== t.patientCard.requestContact) {
        expect(
          screen.queryByRole('button', { name: t.caseActions.notify }),
        ).not.toBeInTheDocument();
      }

      // Opening the other case keeps the card and shows that case's detail.
      const other = rows.find((row) => row.getAttribute('aria-current') !== 'true');
      if (other === undefined) throw new Error('expected a second case');
      const href = other.getAttribute('href');
      await user.click(other);
      await waitFor(() => {
        const opened = screen
          .getAllByRole('link')
          .find((link) => link.getAttribute('href') === href);
        expect(opened).toHaveAttribute('aria-current', 'true');
      });

      // One request for the patient: both cases are notified.
      await user.click(screen.getByRole('button', { name: t.patientCard.requestContact }));
      const dialog = await screen.findByRole('dialog', { name: t.patientCard.requestTitle });
      expect(
        within(dialog).getByText(t.patientCard.requestBody(PATIENT_NAME, 2)),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t.patientCard.requestContact }));
      expect(await screen.findByText(t.patientCard.done)).toBeInTheDocument();
      const patientId = store.listPatients(PATIENT_NAME).items[0]?.id ?? 'missing';
      expect(store.getPatientCard(patientId).cases.map((view) => view.status)).toEqual([
        'notified',
        'notified',
      ]);
      // Within the window the patient cannot be asked again, from any case.
      await user.click(screen.getByRole('button', { name: t.patientCard.requestContact }));
      const again = await screen.findByRole('dialog', { name: t.patientCard.requestTitle });
      await user.click(within(again).getByRole('button', { name: t.patientCard.requestContact }));
      expect(await within(again).findByText(api.patientQueue.contactWindow)).toBeInTheDocument();
    });

    it('counts patients first and cases second in the list', async () => {
      const { store } = renderApp('/inbox', { locale });
      const { activePatients, activeCases } = store.stats();
      expect(
        await screen.findByText(
          t.inbox.showingPatients(activePatients, activePatients, activeCases),
        ),
      ).toBeInTheDocument();
    });
  });

  describe('the filter bar', () => {
    it('filters by reason type and by condition together, then clears', async () => {
      const { user } = renderApp('/inbox', { locale });
      // Fernando Ríos: one reason, the hypertension protocol. María Fernanda
      // Ortiz: a doctor's-plan and a universal reason, no protocol at all.
      await screen.findByRole('link', { name: /Fernando Ríos/ });
      expect(screen.getByRole('link', { name: /María Fernanda Ortiz/ })).toBeInTheDocument();

      const protocolLabel = LAYER_LABELS[locale].protocol;
      await user.click(screen.getByRole('button', { name: startingWith(protocolLabel) }));
      await waitFor(() => {
        expect(
          screen.queryByRole('link', { name: /María Fernanda Ortiz/ }),
        ).not.toBeInTheDocument();
      });
      expect(screen.getByRole('link', { name: /Fernando Ríos/ })).toBeInTheDocument();

      const hypertensionLabel =
        mockProtocolCatalog(locale).find((protocol) => protocol.id === 'hypertension')?.name ?? '';
      await user.click(screen.getByRole('button', { name: startingWith(hypertensionLabel) }));
      // Scoped to the queue list: the sidebar has its own links.
      const patientLinks = () =>
        screen
          .getAllByRole('link')
          .filter((link) => (link.getAttribute('href') ?? '').startsWith('/inbox/'));
      await waitFor(() => {
        expect(patientLinks()).toHaveLength(1);
      });
      expect(screen.getByRole('link', { name: /Fernando Ríos/ })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: t.inbox.filters.clear }));
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /María Fernanda Ortiz/ })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: t.inbox.filters.clear })).not.toBeInTheDocument();
    });
  });

  describe('plan item review', () => {
    it('confirms a plan item in one click', async () => {
      const { user } = await planReason();
      await user.click(screen.getByRole('button', { name: t.planReview.confirm }));
      expect(
        await screen.findByText(startingWith(t.planReview.confirmedBy(''))),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t.planReview.confirm })).not.toBeInTheDocument();
    });

    it('validates a correction on click, then corrects the kind', async () => {
      const { user } = await planReason();
      await user.click(screen.getByRole('button', { name: t.planReview.correct }));
      const dialog = await screen.findByRole('dialog', { name: t.planReview.correctTitle });
      const save = within(dialog).getByRole('button', { name: t.planReview.save });
      expect(save).toBeEnabled();
      await user.click(save);
      expect(within(dialog).getByText(t.planReview.nothingChanged)).toBeInTheDocument();
      await user.selectOptions(within(dialog).getByLabelText(t.planReview.kindLabel), 'lab');
      await user.click(save);
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(
        await screen.findByText(startingWith(t.planReview.correctedBy(''))),
      ).toBeInTheDocument();
    });

    it('rejects a plan item and resolves the case it was the only reason of', async () => {
      const { user } = await planReason();
      await user.click(screen.getByRole('button', { name: t.planReview.reject }));
      const dialog = await screen.findByRole('dialog', { name: t.planReview.rejectTitle });
      await user.click(within(dialog).getByRole('button', { name: t.planReview.rejectConfirm }));
      expect(
        await screen.findByRole('heading', { name: startingWith(t.patientCard.closedTitle) }),
      ).toBeInTheDocument();
    });

    it('shows the review on the patient page too', async () => {
      // Ids are deterministic: a fresh store mints the same patient id.
      const patientId = twoCases(createMockStore());
      const { user } = renderApp(`/patients/${patientId}`, { locale, handlers: withTwoCases });
      await screen.findByRole('heading', { name: PATIENT_NAME, level: 1 });
      expect(screen.getByText(t.planReview.pending)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: t.planReview.confirm }));
      expect(
        await screen.findByText(startingWith(t.planReview.confirmedBy(''))),
      ).toBeInTheDocument();
    });
  });
});
