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
 * A fresh evaluator lab, with no patients yet: the login, the "New patient"
 * dialog, "Add to the record" and the expectations GET are all handled, in
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
      const current = expectationsByPatient.get(body.patientId) ?? [];
      expectationsByPatient.set(body.patientId, [...current, created]);
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
  it('creates a lab patient, adds a visit record, and shows the new expectation', async () => {
    const rendered = renderApp('/lab', { handlers: labHandlers });

    await screen.findByText(/have not created a lab patient yet/i);

    await rendered.user.click(screen.getByRole('button', { name: /New patient/i }));
    const dialog = await screen.findByRole('dialog');
    await rendered.user.type(within(dialog).getByLabelText('Name'), 'Ana Pérez');
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Create patient' }));

    await screen.findByRole('button', { name: /Ana Pérez/ });

    const typeSelect = await screen.findByLabelText('Type');
    await rendered.user.selectOptions(typeSelect, 'visit');
    await rendered.user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Follow-up visit pending');
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText(/Saved to the record/i)).toBeInTheDocument();
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

    await rendered.user.click(await screen.findByRole('button', { name: /Test Patient/ }));
    const typeSelect = await screen.findByLabelText('Type');
    await rendered.user.selectOptions(typeSelect, 'diagnosis');
    await rendered.user.selectOptions(screen.getByLabelText(/Diagnosis \(ICD-10\)/), '__other__');
    // The code field is left empty: the click must validate and refuse to submit.
    await rendered.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
  });
});
