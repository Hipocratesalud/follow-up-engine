import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { LabHistoryImportResponse, LabHistorySampleSet } from '../../api/contract.ts';
import { renderApp } from '../../test/render.tsx';

const NOW = '2026-01-05T12:00:00.000Z';

afterEach(() => {
  sessionStorage.clear();
});

const SAMPLES: LabHistorySampleSet = {
  sets: [
    {
      id: 'rafael',
      patient: { name: 'Rafael Antonio Méndez', sex: 'male', age: 62 },
      documents: [
        {
          filename: '2024-02-12-nota-control.txt',
          contentType: 'text/plain',
          dataBase64: btoa('Solicito HbA1c y control en 3 meses.'),
          documentDate: '2024-02-12',
          documentType: 'consultation_note',
        },
        {
          filename: '2025-12-15-foto-resultado.jpg',
          contentType: 'image/jpeg',
          dataBase64: btoa('jpeg'),
          documentDate: '2025-12-15',
          documentType: 'lab_result',
        },
      ],
    },
  ],
};

const RESPONSE: LabHistoryImportResponse = {
  patientId: 'pat-lab-1',
  clinicId: 'lab-1',
  documents: [
    {
      index: 0,
      filename: '2024-02-12-nota-control.txt',
      documentDate: '2024-02-12',
      documentType: 'consultation_note',
      readAs: 'note',
      source: 'text',
      status: 'staged',
      resources: ['DocumentReference/hist-1-note'],
    },
    {
      index: 1,
      filename: '2025-12-15-foto-resultado.jpg',
      documentDate: '2025-12-15',
      documentType: 'lab_result',
      readAs: 'lab_report',
      source: 'photo',
      status: 'staged',
      results: [{ test: 'HbA1c', loinc: '4548-4', value: 8.4, unit: '%', interpretation: 'H' }],
      resources: ['Observation/hist-obs-1-hba1c'],
      reading: { model: 'meta:muse-spark-1.3', costUsd: 0.004, latencyMs: 900 },
    },
  ],
  eventsStaged: 3,
  backfill: {
    runId: 'history-1',
    status: 'completed',
    resumed: false,
    expectationsCreated: 5,
    expectationsFulfilled: 2,
    casesOpened: 1,
    notesRead: 1,
    notesLlmCostUsd: 0.002,
    release: { scheduled: 1, notNotified: 0, perDay: [0, 1] },
  },
  cases: [{ id: 'case-1', status: 'open', releaseAt: '2026-01-06T12:00:00.000Z', released: false }],
  llm: { calls: 2, costUsd: 0.006 },
};

describe('Import history (the Lab page)', () => {
  it('loads a sample history, sends every file with its date and type, and shows what the backfill did', async () => {
    const sent: { documents: unknown; files: string[]; newPatient: unknown }[] = [];
    const rendered = renderApp('/lab', {
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: 'doctor@example.com' })),
        http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW, fake: true })),
        http.get('*/api/demo/lab/patients', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/patients/:id/expectations', () =>
          HttpResponse.json({ items: [] }),
        ),
        http.get('*/api/demo/lab/cases', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/recovery', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('*/api/demo/lab/history/samples', () => HttpResponse.json(SAMPLES)),
        http.post('*/api/demo/lab/history', async ({ request }) => {
          const form = await request.formData();
          sent.push({
            documents: JSON.parse(form.get('documents') as string) as unknown,
            newPatient: JSON.parse(form.get('newPatient') as string) as unknown,
            files: form.getAll('files').map((file) => (file as File).name),
          });
          return HttpResponse.json(RESPONSE, { status: 201 });
        }),
      ],
    });

    const form = await screen.findByRole('form', { name: 'Import history' });
    await rendered.user.click(
      await within(form).findByRole('button', { name: 'Rafael Antonio Méndez (2 documents)' }),
    );
    expect(within(form).getByText('2024-02-12-nota-control.txt')).toBeInTheDocument();
    expect(within(form).getByText('Read as a lab report')).toBeInTheDocument();
    await rendered.user.click(within(form).getByRole('button', { name: 'Import history' }));

    expect(await screen.findByText('What the import did')).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.files).toEqual([
      '2024-02-12-nota-control.txt',
      '2025-12-15-foto-resultado.jpg',
    ]);
    expect(sent[0]?.documents).toEqual([
      { documentDate: '2024-02-12', documentType: 'consultation_note' },
      { documentDate: '2025-12-15', documentType: 'lab_result' },
    ]);
    expect(sent[0]?.newPatient).toEqual({ name: 'Rafael Antonio Méndez', sex: 'male', age: 62 });
    expect(
      screen.getByText(
        '5 expectations from the history (origin: history review), 2 already fulfilled by it, 1 case held for follow-up.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Daily cap: 0 cases released today, 1 waiting in “To recover”.'),
    ).toBeInTheDocument();
    expect(screen.getByText('HbA1c: 8.4 % (high)')).toBeInTheDocument();
  });
});
