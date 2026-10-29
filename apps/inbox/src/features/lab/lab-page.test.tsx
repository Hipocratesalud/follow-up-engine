import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  LabExpectationView,
  LabPatient,
  LabPatientCreateRequest,
  LabRecordAddRequest,
} from '../../api/contract.ts';
import { renderApp } from '../../test/render.tsx';

const EVALUATOR_EMAIL = 'doctor@example.com';
const NOW = '2026-01-05T12:00:00.000Z';

afterEach(() => {
  sessionStorage.clear();
});

/**
 * A fresh evaluator lab, with no patients yet: the login, "+ New patient",
 * the document upload and the structured record form are all handled, in
 * memory for the test's lifetime.
 */
function labHandlers() {
  const patients: LabPatient[] = [];
  const expectationsByPatient = new Map<string, LabExpectationView[]>();
  let nextExpectationId = 1;

  return [
    http.get('*/api/evaluator/me', () => HttpResponse.json({ email: EVALUATOR_EMAIL })),
    http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW, fake: true })),
    http.get('*/api/demo/lab/patients', () => HttpResponse.json({ items: patients })),
    http.post('*/api/demo/lab/patients', async ({ request }) => {
      const body = (await request.json()) as LabPatientCreateRequest;
      const patient: LabPatient = {
        id: `pat-lab-${String(patients.length + 1)}`,
        name: body.name,
        ...(body.sex === undefined ? {} : { sex: body.sex }),
        ...(body.age === undefined ? {} : { age: body.age }),
      };
      patients.push(patient);
      return HttpResponse.json(patient, { status: 201 });
    }),
    http.post('*/api/demo/lab/documents', async ({ request }) => {
      const body = (await request.json()) as {
        patientId: string;
        text?: string;
        documentDate?: string;
        documentType?: string;
      };
      const patientId = body.patientId;
      const created: LabExpectationView = {
        id: `exp-${String(nextExpectationId)}`,
        ruleId: 'doctor_plan_followup',
        layer: 'doctor_plan',
        label: 'Follow-up visit pending',
        status: 'open',
        dueAt: '2026-04-05T00:00:00.000Z',
      };
      nextExpectationId += 1;
      expectationsByPatient.set(patientId, [
        ...(expectationsByPatient.get(patientId) ?? []),
        created,
      ]);
      return HttpResponse.json(
        {
          patientId,
          clinicId: 'lab-clinic',
          documentDate: body.documentDate ?? '2026-01-05',
          documentType: body.documentType ?? 'consultation_note',
          text: body.text ?? '',
          extraction: {
            model: 'fake-regex-extractor',
            hasPlan: true,
            conditions: [],
            medications: [],
            planItems: [
              {
                kind: 'follow_up_visit',
                description: 'Control en 3 meses',
                dueAt: '2026-04-05T00:00:00.000Z',
                evidenceQuote: 'Control en 3 meses',
                confidence: 0.9,
              },
              // Two lab items quoting the same phrase ("HbA1c y perfil
              // lipídico"): the regression showed both titled plainly "Lab
              // test", indistinguishable. `testName` must tell them apart.
              {
                kind: 'lab',
                description: 'HbA1c',
                dueAt: '2026-04-05T00:00:00.000Z',
                evidenceQuote: 'Control en 3 meses con HbA1c y perfil lipídico',
                confidence: 0.9,
                testName: 'HbA1c',
              },
              {
                kind: 'lab',
                description: 'lipid panel',
                dueAt: '2026-04-05T00:00:00.000Z',
                evidenceQuote: 'Control en 3 meses con HbA1c y perfil lipídico',
                confidence: 0.9,
                testName: 'Lipid panel',
              },
            ],
            costUsd: 0,
            latencyMs: 5,
          },
          expectationsCreated: [
            {
              id: created.id,
              ruleId: created.ruleId,
              layer: created.layer,
              label: created.label,
              dueAt: created.dueAt,
            },
          ],
        },
        { status: 201 },
      );
    }),
    http.post('*/api/demo/lab/records', async ({ request }) => {
      const body = (await request.json()) as LabRecordAddRequest;
      const created: LabExpectationView = {
        id: `exp-${String(nextExpectationId)}`,
        ruleId: 'doctor_plan_followup',
        layer: 'doctor_plan',
        label: 'Follow-up visit pending',
        status: 'open',
        dueAt: '2026-04-05T00:00:00.000Z',
      };
      nextExpectationId += 1;
      expectationsByPatient.set(body.patientId, [
        ...(expectationsByPatient.get(body.patientId) ?? []),
        created,
      ]);
      return HttpResponse.json(
        { patientId: body.patientId, clinicId: 'lab-clinic', expectationsCreated: [created] },
        { status: 201 },
      );
    }),
    http.get('*/api/demo/lab/patients/:id/expectations', ({ params }) => {
      const id = typeof params['id'] === 'string' ? params['id'] : '';
      return HttpResponse.json({ items: expectationsByPatient.get(id) ?? [] });
    }),
    http.get('*/api/demo/lab/cases', () => HttpResponse.json({ items: [] })),
  ];
}

describe('the Lab page', () => {
  it('creates a lab patient inline and reads a pasted document', async () => {
    const rendered = renderApp('/lab', { handlers: labHandlers });

    await screen.findByText(/Upload a report or document/i);
    const patientSelect = await screen.findByLabelText('Select a patient');
    await rendered.user.selectOptions(patientSelect, '+ New patient');

    await rendered.user.type(screen.getByLabelText('Name'), 'Ana Pérez');

    await rendered.user.click(screen.getByRole('button', { name: /or paste the text/i }));
    await rendered.user.type(
      screen.getByLabelText('Text'),
      'Paciente con DM2. Control en 3 meses con HbA1c.',
    );
    await rendered.user.click(screen.getByRole('button', { name: 'Read document' }));

    await screen.findAllByText(/Follow-up visit pending/);
    expect(screen.getByText('What the engine expects now')).toBeInTheDocument();
    expect(screen.getAllByText(/Control en 3 meses/).length).toBeGreaterThan(0);

    // Regression: the timeline must show the document's own date (today in
    // the lab's clock, Jan 5 2026) and a clear label naming its type, never
    // the due date of a plan item it created (Apr 5 2026).
    expect(await screen.findByText('Document uploaded: Consultation note')).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Apr 5, 2026')).not.toBeInTheDocument();

    // Regression: two lab plan items quoting the same phrase must read as
    // two different tests, not two identical "Lab test" entries.
    expect(screen.getByText('Lab test: HbA1c')).toBeInTheDocument();
    expect(screen.getByText('Lab test: Lipid panel')).toBeInTheDocument();
  });

  it("does not send a request when the diagnosis form's required field is empty", async () => {
    const rendered = renderApp('/lab', {
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: EVALUATOR_EMAIL })),
        http.get('*/api/demo/lab/clock', () => HttpResponse.json({ now: NOW, fake: true })),
        http.get('*/api/demo/lab/patients', () =>
          HttpResponse.json({ items: [{ id: 'pat-lab-1', name: 'Test Patient' }] }),
        ),
        http.get('*/api/demo/lab/patients/:id/expectations', () =>
          HttpResponse.json({ items: [] }),
        ),
        http.get('*/api/demo/lab/cases', () => HttpResponse.json({ items: [] })),
        http.post('*/api/demo/lab/records', () => {
          throw new Error('must not be called: the diagnosis field was left empty');
        }),
      ],
    });

    const patientSelect = await screen.findByLabelText('Select a patient');
    await screen.findByRole('option', { name: 'Test Patient' });
    await rendered.user.selectOptions(patientSelect, 'Test Patient');

    await rendered.user.click(screen.getByRole('button', { name: 'Show' }));
    const form = await screen.findByRole('form', { name: /Add something without a document/i });
    await rendered.user.selectOptions(within(form).getByLabelText('Type'), 'diagnosis');
    await rendered.user.selectOptions(
      within(form).getByLabelText(/Diagnosis \(ICD-10\)/),
      '__other__',
    );
    // The code field is left empty: the click must validate and refuse to submit.
    await rendered.user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('This field is required.')).toBeInTheDocument();
  });
});
