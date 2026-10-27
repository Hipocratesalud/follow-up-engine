import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale, messagesFor } from './i18n/index.ts';
import { formatDate } from './lib/format.ts';
import { mockApiCopy } from './mocks/api-copy.ts';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/**
 * The key flows of the inbox, run in every UI language: each assertion reads
 * its words from the catalogs (`src/i18n`) and the mock API's copy, so a
 * screen left with words of the other language fails here.
 */

/** case-001 is the seeded diabetes patient with a doctor's-plan reason quoted from her note. */
const DIABETES_CASE = '/inbox/case-001';

function first(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements;
  if (!element) throw new Error('expected at least one element');
  return element;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.each(LOCALES)('key flows in %s', (locale: Locale) => {
  const t = messagesFor(locale);
  const api = mockApiCopy(locale);
  const overdue = new RegExp(escape(t.time.overdue(2)).replace('2', '\\d+').split(' ')[0] ?? '');

  describe('inbox', () => {
    it('lists active cases ordered by priority, with layer chips and stats', async () => {
      renderApp('/inbox', { locale });
      const rows = await screen.findAllByRole('link', { name: overdue });
      expect(rows.length).toBeGreaterThan(10);
      expect(within(first(rows)).getByText(t.labels.priorities.urgente)).toBeInTheDocument();
      expect(screen.getAllByText(t.labels.layers.doctor_plan).length).toBeGreaterThan(0);
      expect(await screen.findByText(t.stats.aiCost)).toBeInTheDocument();
      expect(screen.getByText(/Muse Spark · Meta/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: t.inbox.title })).toBeInTheDocument();
      // The clinic name comes from GET /api/inbox/clinic, not from the bundle.
      expect((await screen.findAllByText('Centro Médico Los Álamos')).length).toBeGreaterThan(0);
    });

    it('cites the doctor verbatim, in the language the doctor wrote', async () => {
      renderApp(DIABETES_CASE, { locale });
      const marks = await screen.findAllByTestId('evidence-quote');
      const mark = first(marks);
      expect(mark.tagName).toBe('MARK');
      // Clinical content is never translated.
      expect(mark).toHaveTextContent('control en 3 meses con HbA1c y perfil lipídico');
      const excerpt = mark.closest('blockquote');
      expect(excerpt).toHaveTextContent(
        /Paciente femenina de 58 años con DM2.*Plan: control en 3 meses/,
      );
      expect(screen.getAllByText(t.evidence.title).length).toBe(marks.length);
    });

    it('resolving a case updates its status and removes it from the active list', async () => {
      const { user } = renderApp(DIABETES_CASE, { locale });
      await user.click(await screen.findByRole('button', { name: t.caseActions.resolve }));
      const dialog = await screen.findByRole('dialog', { name: t.caseActions.resolveTitle });
      await user.type(
        within(dialog).getByLabelText(t.caseActions.noteOptional),
        'Trajo el resultado',
      );
      await user.click(within(dialog).getByRole('button', { name: t.caseActions.resolveConfirm }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(
        await screen.findByText(
          t.caseDetail.closedNotice(t.labels.statuses.resolved.toLowerCase()),
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByText(api.timeline.resolvedByTeam).length).toBeGreaterThan(0);
      // The team's own note is shown as written.
      expect(screen.getByText('Trajo el resultado')).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.queryByRole('link', { name: /María Fernanda Ortiz/ }),
        ).not.toBeInTheDocument();
      });
    });

    it('never sends a diagnosis in the patient message preview', async () => {
      const { user } = renderApp(DIABETES_CASE, { locale });
      await user.click(await screen.findByRole('button', { name: t.caseActions.notify }));
      const dialog = await screen.findByRole('dialog', { name: t.caseActions.notifyTitle });
      const preview = within(dialog).getByText(t.caseActions.patientMessage('María'));
      expect(preview.textContent).not.toMatch(/diabetes|DM2|HbA1c|lipid/i);

      await user.click(within(dialog).getByRole('button', { name: t.caseActions.notifyConfirm }));
      expect(await screen.findByText(t.caseActions.notifyDone)).toBeInTheDocument();
      expect(screen.getAllByText(t.labels.statuses.notified).length).toBeGreaterThan(0);
    });

    it('explains instead of contacting a patient who opted out', async () => {
      const { user, store } = renderApp('/inbox', { locale });
      const optedOut = store
        .listCases({ view: 'active' })
        .items.find((item) => item.patientContact.optedOut);
      const name = optedOut?.patient.name ?? '';
      await user.click(await screen.findByRole('link', { name: new RegExp(name) }));
      await user.click(await screen.findByRole('button', { name: t.caseActions.notify }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.caseActions.noMessages(name))).toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: t.caseActions.notifyConfirm }),
      ).not.toBeInTheDocument();
    });
  });

  describe('feedback', () => {
    it('requires a reason when the case was not useful', async () => {
      const { user, store } = renderApp(DIABETES_CASE, { locale });
      await user.click(await screen.findByRole('button', { name: t.feedback.notUseful }));
      await user.click(screen.getByRole('button', { name: t.feedback.send }));

      expect(await screen.findByText(t.validation.feedbackReasonRequired)).toBeInTheDocument();
      expect(store.getCase('case-001').feedback).toBeUndefined();

      await user.click(screen.getByLabelText(t.labels.feedbackReasons.wrong_interval));
      await user.type(screen.getByLabelText(t.feedback.comment), 'Era control semestral');
      await user.click(screen.getByRole('button', { name: t.feedback.send }));

      expect(
        await screen.findByText(new RegExp(escape(t.feedback.markedNotUseful))),
      ).toBeInTheDocument();
      expect(store.getCase('case-001').feedback).toEqual({
        useful: false,
        reason: 'wrong_interval',
        comment: 'Era control semestral',
      });
    });

    it('records a useful verdict in one click', async () => {
      const { user, store } = renderApp(DIABETES_CASE, { locale });
      await user.click(await screen.findByRole('button', { name: t.feedback.useful }));
      expect(await screen.findByText(t.feedback.markedUseful)).toBeInTheDocument();
      expect(store.getCase('case-001').feedback).toEqual({ useful: true });
    });
  });

  describe('patient', () => {
    it('confirms a probable condition extracted by the AI, with its evidence', async () => {
      const patientId = createMockStore()
        .listCases({ view: 'active' })
        .items.find((item) => item.patient.name === 'Ana Lucía Torres')?.patient.id;
      const { user } = renderApp(`/patients/${patientId ?? ''}`, { locale });
      const condition = (await screen.findByText(api.conditionNames['E28.2'] ?? '')).closest(
        'li',
      ) as HTMLElement;
      // The quote is the doctor's words, untranslated.
      expect(
        within(condition).getByText('Se sospecha síndrome de ovario poliquístico'),
      ).toBeInTheDocument();
      expect(within(condition).getByText(t.labels.conditionStatuses.probable)).toBeInTheDocument();

      await user.click(within(condition).getByRole('button', { name: t.patient.confirm }));
      await waitFor(() => {
        expect(
          within(condition).getByText(t.labels.conditionStatuses.confirmed),
        ).toBeInTheDocument();
      });
    });

    it("shows the patient's preferred language, named in the UI language", async () => {
      const patientId = createMockStore().listCases({ view: 'active' }).items[0]?.patient.id;
      renderApp(`/patients/${patientId ?? ''}`, { locale });
      const name = new Intl.DisplayNames([locale], { type: 'language' }).of('es-VE') ?? '';
      expect(
        await screen.findByText(
          t.common.preferredLanguage(name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)),
        ),
      ).toBeInTheDocument();
    });
  });

  describe('demo', () => {
    it('runs a consultation end to end: extraction, expectations, clock and the new case', async () => {
      const { user, store } = renderApp('/demo', { locale });
      await user.click(
        await screen.findByRole('button', {
          name: t.consultation.examples['psychology-plan'] ?? '',
        }),
      );
      await user.click(screen.getByRole('button', { name: t.consultation.save }));

      const result = await screen.findByRole('region', {
        name: t.extraction.readingOf('Muse Spark'),
      });
      expect(within(result).getByText('muse-spark')).toBeInTheDocument();
      expect(
        within(result).getAllByText('sesiones semanales durante 10 semanas').length,
      ).toBeGreaterThan(0);
      expect(within(result).getByText(api.demo.plan.session)).toBeInTheDocument();
      expect(within(result).getByText(api.conditionNames['F41.0'] ?? '')).toBeInTheDocument();
      // A Spanish note is read as Spanish whatever the UI language.
      expect(
        within(result).getByText(new RegExp(escape(t.extraction.noteLanguage('').trim()))),
      ).toBeInTheDocument();

      const before = store.now();
      await user.click(screen.getByRole('button', { name: t.demo.daysButton(30) }));
      expect(await screen.findByText(new RegExp(escape(t.demo.passed(30))))).toBeInTheDocument();
      const after = new Date(before.getTime() + 30 * 86_400_000).toISOString();
      expect(
        (await screen.findAllByText(new RegExp(escape(formatDate(after))))).length,
      ).toBeGreaterThan(0);
      expect(
        (await screen.findAllByText(t.labels.webhooks['case.escalated'] ?? '')).length,
      ).toBeGreaterThan(0);

      await user.click(first(screen.getAllByRole('link', { name: new RegExp(t.nav.inbox) })));
      await user.click(await screen.findByRole('link', { name: /Diego Hernández/ }));
      const quotes = await screen.findAllByTestId('evidence-quote');
      expect(quotes.map((quote) => quote.textContent)).toContain(
        'sesiones semanales durante 10 semanas',
      );
    });

    it('reads an English note as English, with its plan and quotes in English', async () => {
      const { user } = renderApp('/demo', { locale });
      await user.click(
        await screen.findByRole('button', {
          name: t.consultation.examples['english-hypertension'] ?? '',
        }),
      );
      await user.click(screen.getByRole('button', { name: t.consultation.save }));
      const result = await screen.findByRole('region', {
        name: t.extraction.readingOf('Muse Spark'),
      });
      const english = new Intl.DisplayNames([locale], { type: 'language' }).of('en') ?? '';
      expect(
        within(result).getByText(
          t.extraction.noteLanguage(english.charAt(0).toLocaleUpperCase(locale) + english.slice(1)),
        ),
      ).toBeInTheDocument();
      expect(within(result).getAllByText('RTC in 6 wks to recheck BP').length).toBeGreaterThan(0);
      expect(within(result).getByText(api.conditionNames['I10'] ?? '')).toBeInTheDocument();
    });

    it('validates the consultation form on submit instead of disabling it', async () => {
      const { user } = renderApp('/demo', { locale });
      await user.click(await screen.findByRole('button', { name: t.consultation.save }));
      expect(await screen.findByText(t.validation.patientRequired)).toBeInTheDocument();
      expect(screen.getByText(t.validation.noteRequired)).toBeInTheDocument();
    });
  });

  describe('recovery', () => {
    it('lists backfill patients waiting to be released and says they are not notifications', async () => {
      renderApp('/recovery', { locale });
      expect(await screen.findByText(t.recovery.noticeTitle)).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: /Mercedes Rangel/ })).toBeInTheDocument();
      const prefixes = [
        t.caseRow.releaseToday(''),
        t.caseRow.releaseTomorrow(''),
        t.caseRow.releaseOn(''),
      ].map((text) => text.replace(/\(?\)?$/, '').trim());
      const releases = screen.getAllByText(
        (_, element) =>
          element?.tagName === 'SPAN' &&
          prefixes.some((prefix) => element.textContent.startsWith(prefix)),
      );
      expect(releases.length).toBe(6);
    });
  });
});
