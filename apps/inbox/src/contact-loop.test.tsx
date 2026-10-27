import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale, messagesFor } from './i18n/index.ts';
import { createMockStore, MockHttpError, type MockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-136: the patient-contact loop and dismissals that stick, through the
 * UI against the mock API (same contract as apps/api), in every UI language.
 */

function storeIn(locale: Locale): MockStore {
  const store = createMockStore();
  store.setLocale(locale);
  return store;
}

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

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.each(LOCALES)('contact loop in %s', (locale: Locale) => {
  const t = messagesFor(locale);

  async function openDismissDialog(caseId: string) {
    const rendered = renderApp(`/inbox/${caseId}`, { locale });
    await rendered.user.click(await screen.findByRole('button', { name: t.caseActions.dismiss }));
    const dialog = await screen.findByRole('dialog', { name: t.caseActions.dismissTitle });
    return { ...rendered, dialog };
  }

  describe('dismiss dialog', () => {
    it('asks for a reason on click, and a note for "other", never disabling the button', async () => {
      const caseId = caseOf('José Luis Méndez');
      const { user, dialog, store } = await openDismissDialog(caseId);
      const confirm = within(dialog).getByRole('button', { name: t.caseActions.dismissConfirm });
      expect(confirm).toBeEnabled();

      await user.click(confirm);
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        t.validation.dismissReasonRequired,
      );
      expect(store.getCase(caseId).status).not.toBe('dismissed');

      await user.click(
        within(dialog).getByRole('radio', { name: new RegExp(t.labels.dismissReasons.other) }),
      );
      expect(
        within(dialog).queryByText(t.validation.dismissReasonRequired),
      ).not.toBeInTheDocument();
      await user.click(confirm);
      expect(within(dialog).getByRole('alert')).toHaveTextContent(t.validation.dismissNoteRequired);

      await user.type(
        within(dialog).getByLabelText(t.dismiss.noteLabelRequired),
        'Duplicado de otro caso',
      );
      await user.click(confirm);
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(store.getCase(caseId).dismissal).toMatchObject({
        reason: 'other',
        note: 'Duplicado de otro caso',
      });
      expect(
        await screen.findByRole('heading', { name: t.contact.dismissalTitle }),
      ).toBeInTheDocument();
      // The verdict is the dismissal reason: no separate "Was this useful?" on a dismissed case.
      expect(screen.queryByText(t.caseDetail.feedbackTitle)).not.toBeInTheDocument();
    });

    it('"Does not apply to this patient" can stop protocol and visit-pattern reminders for this patient only', async () => {
      const caseId = caseOf('Luis Alberto Herrera');
      const labels = storeIn(locale)
        .getCase(caseId)
        .reasons.filter((reason) => reason.suppressible)
        .map((reason) => escape(reason.label));
      const { user, dialog, store } = await openDismissDialog(caseId);
      expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
      await user.click(
        within(dialog).getByRole('radio', {
          name: new RegExp(t.labels.dismissReasons.not_applicable_to_patient),
        }),
      );
      const checkbox = within(dialog).getByRole('checkbox', {
        name: new RegExp(t.dismiss.suppressLabel),
      });
      // The checkbox names which reminders it stops.
      expect(checkbox).toHaveAccessibleDescription(
        new RegExp(`${escape(t.dismiss.suppressListTitle)}.*${labels.join('.*')}`),
      );
      await user.click(checkbox);
      await user.click(within(dialog).getByRole('button', { name: t.caseActions.dismissConfirm }));

      const summary = await screen.findByRole('region', { name: t.contact.dismissalTitle });
      expect(within(summary).getByText(t.contact.suppressedTitle)).toBeInTheDocument();
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
      await user.click(
        within(dialog).getByRole('radio', {
          name: new RegExp(t.labels.dismissReasons.not_applicable_to_patient),
        }),
      );
      expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(within(dialog).getByText(t.dismiss.nothingSuppressible)).toBeInTheDocument();
    });

    it('a case with both kinds says which reminders stay active', async () => {
      const store = storeIn(locale);
      const mixed = store
        .listCases({ view: 'active', limit: 200 })
        .items.find(
          (item) =>
            item.reasons.some((reason) => reason.suppressible) &&
            item.reasons.some((reason) => !reason.suppressible),
        );
      if (!mixed) throw new Error('expected a seeded case with both kinds of reasons');
      const kept = mixed.reasons
        .filter((reason) => !reason.suppressible)
        .map((reason) => reason.label);
      const { user, dialog } = await openDismissDialog(mixed.id);
      await user.click(
        within(dialog).getByRole('radio', {
          name: new RegExp(t.labels.dismissReasons.not_applicable_to_patient),
        }),
      );
      expect(within(dialog).getByRole('checkbox')).toHaveAccessibleDescription(
        new RegExp(escape(t.dismiss.suppressKept([...new Set(kept)]))),
      );
    });

    it('"The diagnosis is wrong" points to the patient page to reject the condition', async () => {
      const { user, dialog } = await openDismissDialog(caseOf('José Luis Méndez'));
      await user.click(
        within(dialog).getByRole('radio', {
          name: new RegExp(t.labels.dismissReasons.wrong_diagnosis),
        }),
      );
      expect(
        within(dialog).getByRole('link', { name: t.dismiss.wrongDiagnosisLink }),
      ).toHaveAttribute('href', `/patients/${patientOf('José Luis Méndez')}`);
    });

    it('the mock API mirrors the 422s of the real one, in the request language', () => {
      const store = storeIn(locale);
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
      try {
        store.act(caseId, { action: 'dismiss' });
      } catch (error) {
        expect(error).toMatchObject({ message: t.validation.dismissReasonRequired });
      }
    });
  });

  describe('contact with the patient', () => {
    it('shows every attempt with its channel and outcome, and the call task records an outcome', async () => {
      const caseId = caseOf('Rosa Inés Montilla');
      const { user, store } = renderApp(`/inbox/${caseId}`, { locale });
      const timeline = await screen.findByRole('region', { name: new RegExp(t.contact.title) });
      expect(
        within(timeline).getByText(t.contact.attemptTitle(1, t.labels.channels.whatsapp)),
      ).toBeInTheDocument();
      expect(within(timeline).getByText(t.labels.attemptStatuses.unanswered)).toBeInTheDocument();
      expect(
        within(timeline).getByText(t.contact.attemptTitle(2, t.labels.channels.phone_call)),
      ).toBeInTheDocument();
      expect(within(timeline).getByText(t.labels.attemptStatuses.pending_call)).toBeInTheDocument();

      const task = screen.getByRole('region', { name: t.contact.callTitle });
      const outcomes = within(task)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(outcomes).toEqual([
        t.labels.callOutcomes.booked,
        t.labels.callOutcomes.treated_elsewhere,
        t.labels.callOutcomes.no_answer,
        t.labels.callOutcomes.wrong_number,
        t.labels.callOutcomes.declined,
      ]);
      await user.click(within(task).getByRole('button', { name: t.labels.callOutcomes.booked }));

      await waitFor(() => {
        expect(screen.queryByRole('region', { name: t.contact.callTitle })).not.toBeInTheDocument();
      });
      expect(within(timeline).getByText(t.labels.contactOutcomes.booked)).toBeInTheDocument();
      expect(store.getCase(caseId).contactAttempts[1]).toMatchObject({
        status: 'answered',
        outcome: 'booked',
      });
    });

    it('a wrong number flags the contact data (warning) and the call came forward', async () => {
      renderApp(`/inbox/${caseOf('Luis Alberto Herrera')}`, { locale });
      const marker = t.contact.flagBody('').slice(2, 30);
      expect(await screen.findByText(new RegExp(escape(marker)))).toBeInTheDocument();
      const task = screen.getByRole('region', { name: t.contact.callTitle });
      expect(
        within(task).getByText(
          new RegExp(escape(t.contact.callWrongNumber('Luis Alberto Herrera'))),
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(escape(t.contact.triggers.wrong_number))),
      ).toBeInTheDocument();
    });

    it('"Declined follow-up" on the call closes the case', async () => {
      const caseId = caseOf('Rosa Inés Montilla');
      const { user, store } = renderApp(`/inbox/${caseId}`, { locale });
      const task = await screen.findByRole('region', { name: t.contact.callTitle });
      await user.click(within(task).getByRole('button', { name: t.labels.callOutcomes.declined }));
      expect(
        await screen.findByText(
          t.caseDetail.closedNotice(t.labels.statuses.resolved.toLowerCase()),
        ),
      ).toBeInTheDocument();
      expect(store.getCase(caseId).status).toBe('resolved');
    });
  });

  describe('reminders stopped for a patient', () => {
    it('lists them on the patient page and "Turn back on" turns one back on', async () => {
      const patientId = patientOf('Ricardo Peña');
      const label = storeIn(locale).getPatient(patientId).suppressions[0]?.label ?? '';
      const { user, store } = renderApp(`/patients/${patientId}`, { locale });
      const section = await screen.findByRole('region', {
        name: new RegExp(t.suppressions.title),
      });
      expect(within(section).getByText(label)).toBeInTheDocument();
      expect(
        within(section).getByText(
          new RegExp(`^${escape(t.labels.dismissReasons.not_applicable_to_patient)}`),
        ),
      ).toBeInTheDocument();

      await user.click(within(section).getByRole('button', { name: t.suppressions.reactivate }));
      await waitFor(() => {
        expect(
          within(section).queryByRole('button', { name: t.suppressions.reactivate }),
        ).not.toBeInTheDocument();
      });
      expect(within(section).getByText(t.suppressions.empty)).toBeInTheDocument();
      expect(within(section).getByText(t.suppressions.history(1))).toBeInTheDocument();
      expect(store.getPatient(patientId).suppressions[0]).toMatchObject({ active: false });
    });
  });
});
