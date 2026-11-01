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
      results: [
        {
          name: 'Hemoglobina glicosilada (HbA1c)',
          test: 'HbA1c',
          loinc: '4548-4',
          value: 8.4,
          unit: '%',
          interpretation: 'H',
        },
      ],
      resources: ['Observation/hist-obs-1-hba1c'],
      reading: { model: 'meta:muse-spark-1.3', costUsd: 0.004, latencyMs: 900 },
      nameOnReport: 'matches',
      dates: { printed: '2025-12-01', entered: '2025-12-15', used: 'printed', mismatch: true },
    },
    {
      index: 2,
      filename: 'otro-paciente.pdf',
      documentDate: '2024-05-06',
      documentType: 'lab_result',
      readAs: 'lab_report',
      source: 'text',
      status: 'needs_review',
      reviewReason: 'name_mismatch',
      nameOnReport: 'mismatch',
      resources: [],
    },
  ],
  eventsStaged: 3,
  backfill: {
    runId: 'history-1',
    status: 'completed',
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
        http.get('*/api/demo/lab/held-reports', () => HttpResponse.json({ items: [] })),
        // The lab's finding cards (LabFindingsPanel): none live in these tests.
        http.get('*/api/demo/lab/live-findings', () =>
          HttpResponse.json({ items: [], total: 0, byPatient: {}, queued: 0, dailyCap: 0 }),
        ),
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
    // The test as printed on the report (clinical content stays as written).
    expect(screen.getByText('Hemoglobina glicosilada (HbA1c): 8.4 % (high)')).toBeInTheDocument();
    // Dated by the printed date, with the gap to the entered one flagged.
    expect(screen.getByText('Dec 1, 2025')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Dated by the report: collected Dec 1, 2025 (you entered Dec 15, 2025). Check the date.',
      ),
    ).toBeInTheDocument();
    // Another patient's report: held, shown as such.
    const result = screen.getByText('What the import did').closest('div');
    expect(result).not.toBeNull();
    expect(within(result as HTMLElement).getByText('Needs review')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The name on the report doesn’t match this patient: held for the team, nothing recorded, no order closed.',
      ),
    ).toBeInTheDocument();
  });

  it('offers the sample scanned PDF, and shows a scan read as images or held for the team', async () => {
    const scanned: LabHistorySampleSet = {
      sets: [
        {
          id: 'scanned_pdf',
          kind: 'scanned_pdf',
          patient: { name: 'Jorge Luis Salazar', sex: 'male', age: 58 },
          documents: [
            {
              filename: '2025-03-10-informe-escaneado.pdf',
              contentType: 'application/pdf',
              dataBase64: btoa('%PDF-1.4 image only'),
              documentDate: '2025-03-10',
              documentType: 'lab_result',
            },
          ],
        },
      ],
    };
    const response: LabHistoryImportResponse = {
      ...RESPONSE,
      documents: [
        {
          index: 0,
          filename: '2025-03-10-informe-escaneado.pdf',
          documentDate: '2025-03-10',
          documentType: 'lab_result',
          readAs: 'lab_report',
          source: 'scan',
          status: 'staged',
          results: [
            {
              name: 'Hemoglobina glicosilada (HbA1c)',
              test: 'HbA1c',
              loinc: '4548-4',
              value: 7.9,
              unit: '%',
              interpretation: 'H',
            },
          ],
          resources: ['Observation/hist-obs-1-hba1c'],
          reading: { model: 'meta:muse-spark-1.3', costUsd: 0.004, latencyMs: 7000 },
          nameOnReport: 'matches',
          dates: { printed: '2025-03-10', entered: '2025-03-10', used: 'printed', mismatch: false },
        },
        {
          index: 1,
          filename: 'otro-escaneo.pdf',
          documentDate: '2025-03-10',
          documentType: 'lab_result',
          readAs: 'lab_report',
          source: 'scan',
          status: 'needs_review',
          reviewReason: 'scan_not_allowed',
          resources: [],
        },
      ],
    };
    const sent: string[][] = [];
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
        http.get('*/api/demo/lab/held-reports', () => HttpResponse.json({ items: [] })),
        http.get('*/api/demo/lab/live-findings', () =>
          HttpResponse.json({ items: [], total: 0, byPatient: {}, queued: 0, dailyCap: 0 }),
        ),
        http.get('*/api/demo/lab/history/samples', () => HttpResponse.json(scanned)),
        http.post('*/api/demo/lab/history', async ({ request }) => {
          const form = await request.formData();
          sent.push(form.getAll('files').map((file) => (file as File).name));
          return HttpResponse.json(response, { status: 201 });
        }),
      ],
    });

    const form = await screen.findByRole('form', { name: 'Import history' });
    await rendered.user.click(
      await within(form).findByRole('button', {
        name: 'Sample scanned PDF (Jorge Luis Salazar)',
      }),
    );
    expect(within(form).getByText('2025-03-10-informe-escaneado.pdf')).toBeInTheDocument();
    await rendered.user.click(within(form).getByRole('button', { name: 'Import history' }));

    expect(await screen.findByText('What the import did')).toBeInTheDocument();
    expect(sent).toEqual([['2025-03-10-informe-escaneado.pdf']]);
    expect(
      screen.getByText('Lab report · scanned PDF, read as images · read by meta:muse-spark-1.3'),
    ).toBeInTheDocument();
    expect(screen.getByText('Hemoglobina glicosilada (HbA1c): 7.9 % (high)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This PDF is a scan (no text layer, only images that can’t be masked), and this clinic doesn’t send images to a model: held for the team, nothing sent, nothing recorded.',
      ),
    ).toBeInTheDocument();
  });
});
