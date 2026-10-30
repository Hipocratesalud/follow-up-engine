import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeldLabReportView } from '../../api/contract.ts';
import { renderApp } from '../../test/render.tsx';

const NOW = '2026-01-05T12:00:00.000Z';

afterEach(() => {
  sessionStorage.clear();
});

const HELD: HeldLabReportView = {
  id: 'held-1',
  patientId: 'pat-lab-1',
  filename: 'informe-otro-paciente.pdf',
  documentDate: '2024-05-20',
  printedDate: '2024-05-06',
  printedName: 'Laura Beatriz Ortega',
  recordName: 'Rafael Antonio Méndez',
  reason: 'name_mismatch',
  source: 'text',
  model: 'meta:muse-spark-1.3',
  results: [
    {
      name: 'Hemoglobina glicosilada (HbA1c)',
      test: 'HbA1c',
      loinc: '4548-4',
      value: 6.1,
      unit: '%',
      interpretation: 'H',
    },
  ],
  status: 'pending',
  createdAt: NOW,
};

describe('Needs review (the Lab page)', () => {
  it('lists a held report and records "It’s this patient" for it', async () => {
    let pending = [HELD];
    const decisions: string[] = [];
    const rendered = renderApp('/lab', {
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: 'doctor@example.com' })),
        http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW, fake: true })),
        http.get('*/api/demo/lab/patients', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/cases', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/recovery', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('*/api/demo/lab/history/samples', () => HttpResponse.json({ sets: [] })),
        http.get('*/api/demo/lab/live-findings', () =>
          HttpResponse.json({ items: [], total: 0, byPatient: {}, queued: 0, dailyCap: 0 }),
        ),
        http.get('*/api/demo/lab/held-reports', () => HttpResponse.json({ items: pending })),
        http.post('*/api/demo/lab/held-reports/:id/:decision', ({ params }) => {
          decisions.push(`${String(params['id'])}:${String(params['decision'])}`);
          pending = [];
          return HttpResponse.json({
            report: { ...HELD, status: 'confirmed', decidedBy: 'doctor@example.com' },
            resources: ['Observation/hist-obs-1-hba1c'],
            expectationsFulfilled: 1,
          });
        }),
      ],
    });

    const panel = await screen.findByRole('region', { name: /Needs review/ });
    expect(
      await within(panel).findByText(
        'Name on the report: Laura Beatriz Ortega · In the record: Rafael Antonio Méndez',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Collected May 6, 2024 (entered as May 20, 2024) · read by meta:muse-spark-1.3',
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Hemoglobina glicosilada (HbA1c): 6.1 % (high)'),
    ).toBeInTheDocument();

    await rendered.user.click(within(panel).getByRole('button', { name: 'It’s this patient' }));
    expect(await within(panel).findByText('No report is waiting for review.')).toBeInTheDocument();
    expect(decisions).toEqual(['held-1:confirm']);
  });

  it('shows an unread photo (the clinic does not send photos to a model) with only "Mark reviewed"', async () => {
    const unread: HeldLabReportView = {
      ...HELD,
      id: 'held-2',
      filename: 'foto-resultado.jpg',
      reason: 'photo_not_allowed',
      source: 'photo',
      results: [],
    };
    renderApp('/lab', {
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: 'doctor@example.com' })),
        http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW, fake: true })),
        http.get('*/api/demo/lab/patients', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/cases', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/recovery', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('*/api/demo/lab/history/samples', () => HttpResponse.json({ sets: [] })),
        http.get('*/api/demo/lab/live-findings', () =>
          HttpResponse.json({ items: [], total: 0, byPatient: {}, queued: 0, dailyCap: 0 }),
        ),
        http.get('*/api/demo/lab/held-reports', () => HttpResponse.json({ items: [unread] })),
      ],
    });
    const panel = await screen.findByRole('region', { name: /Needs review/ });
    expect(
      await within(panel).findByText(
        'Photos can’t be read automatically for this clinic. Read it, add the result with “Add something without a document”, then mark it reviewed.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'It’s this patient' })).toBeNull();
  });
});
