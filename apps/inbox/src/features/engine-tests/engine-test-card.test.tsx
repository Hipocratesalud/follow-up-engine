import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EngineTestStepOutcome,
  EngineTestStepRequest,
} from '../../api/engine-tests-contract.ts';
import { renderApp } from '../../test/render.tsx';

const EVALUATOR_EMAIL = 'doctor@example.com';
const SCENARIO_ID = 'expectation-has-due-date';
const DAY0 = '2026-01-05T12:00:00.000Z';
const PATIENT_ID = 'et-guided-1';

afterEach(() => {
  sessionStorage.clear();
});

describe('the guided engine test card', () => {
  it('starts the scenario, lets the physician edit the pre-filled form, loads it, and shows the real check', async () => {
    const captured: EngineTestStepRequest[] = [];
    const rendered = renderApp('/engine-tests', {
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: EVALUATOR_EMAIL })),
        http.get('*/api/demo/engine-tests', () =>
          HttpResponse.json({
            items: [{ id: SCENARIO_ID, group: 'expectations', stepCount: 1, reviewed: false }],
            progress: { reviewed: 0, total: 1 },
          }),
        ),
        http.post(`*/api/demo/engine-tests/${SCENARIO_ID}/start`, () =>
          HttpResponse.json({
            id: SCENARIO_ID,
            patientId: PATIENT_ID,
            day0: DAY0,
            steps: [
              {
                step: 1,
                action: 'record',
                suggestion: {
                  action: 'record',
                  recordDate: '2026-01-05',
                  entry: { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
                },
              },
            ],
          }),
        ),
        http.post(`*/api/demo/engine-tests/${SCENARIO_ID}/steps/1`, async ({ request }) => {
          const body = (await request.json()) as EngineTestStepRequest;
          captured.push(body);
          const display =
            body.value.action === 'record' && body.value.entry.kind === 'order'
              ? body.value.entry.display
              : 'unknown';
          const outcome: EngineTestStepOutcome = {
            id: SCENARIO_ID,
            patientId: PATIENT_ID,
            step: 1,
            timeline: [
              {
                type: 'service_request.created',
                occurredAt: '2026-01-05T12:00:00.000Z',
                source: 'rules',
                detail: {
                  code: 'detailServiceRequestCreated',
                  params: {
                    testName: { kind: 'text', value: display },
                    code: { kind: 'text', value: '4548-4' },
                    category: { kind: 'category', value: 'laboratory' },
                  },
                },
              },
            ],
            expectations: [
              {
                id: 'exp-1',
                ruleId: 'lab_order_result_pending',
                ruleVersion: '1',
                layer: 'universal',
                label: `${display} · due in 15 days`,
                status: 'open',
                dueAt: '2026-01-20T12:00:00.000Z',
                diff: 'new',
              },
            ],
            autoCheck: {
              expected: { code: 'ehdExpected' },
              observed: {
                code: 'obsDueAt',
                params: { date: { kind: 'date', value: '2026-01-20T12:00:00.000Z' } },
              },
              passed: true,
            },
          };
          return HttpResponse.json(outcome);
        }),
        http.post(`*/api/demo/engine-tests/${SCENARIO_ID}/verdict`, () =>
          HttpResponse.json({ id: SCENARIO_ID, verdict: 'works_as_expected' }, { status: 201 }),
        ),
      ],
    });

    await screen.findByText('Every event opens an expectation with a due date');
    await rendered.user.click(screen.getByRole('button', { name: 'Start the test' }));

    await screen.findByText('Order a test');
    const loincField = await screen.findByDisplayValue('4548-4');
    expect(loincField).toBeInTheDocument();
    const displayField = screen.getByDisplayValue('HbA1c');

    // The physician edits the pre-filled suggestion before loading it.
    await rendered.user.clear(displayField);
    await rendered.user.type(displayField, 'Glucose');

    await rendered.user.click(screen.getByRole('button', { name: 'Load' }));

    const matches = await screen.findAllByText(/Due at Jan 20,/);
    expect(matches.length).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    const sentEntry = captured[0]?.value;
    if (sentEntry?.action !== 'record' || sentEntry.entry.kind !== 'order') {
      throw new Error('expected the edited order to be sent');
    }
    expect(sentEntry.entry.display).toBe('Glucose');

    await rendered.user.click(screen.getByRole('button', { name: 'Works as I expect' }));
    await screen.findByText('Verdict saved');
  });

  it('in Spanish, renders a step result with no ISO dates and no English tokens', async () => {
    const scenarioId = 'supersession';
    const rendered = renderApp('/engine-tests', {
      locale: 'es',
      handlers: () => [
        http.get('*/api/evaluator/me', () => HttpResponse.json({ email: EVALUATOR_EMAIL })),
        http.get('*/api/demo/engine-tests', () =>
          HttpResponse.json({
            items: [{ id: scenarioId, group: 'expectations', stepCount: 2, reviewed: false }],
            progress: { reviewed: 0, total: 1 },
          }),
        ),
        http.post(`*/api/demo/engine-tests/${scenarioId}/start`, () =>
          HttpResponse.json({
            id: scenarioId,
            patientId: PATIENT_ID,
            day0: DAY0,
            steps: [
              {
                step: 1,
                action: 'record',
                suggestion: {
                  action: 'record',
                  recordDate: '2026-01-05',
                  entry: { kind: 'order', loinc: '4548-4', display: 'Hemoglobina A1c de control' },
                },
              },
              {
                step: 2,
                action: 'record',
                suggestion: {
                  action: 'record',
                  recordDate: '2026-01-05',
                  entry: { kind: 'order', loinc: '4548-4', display: 'Hemoglobina A1c de control' },
                },
              },
            ],
          }),
        ),
        http.post(`*/api/demo/engine-tests/${scenarioId}/steps/:n`, ({ params }) => {
          const step = Number(typeof params['n'] === 'string' ? params['n'] : '0');
          const outcome: EngineTestStepOutcome = {
            id: scenarioId,
            patientId: PATIENT_ID,
            step,
            timeline: [
              {
                type: 'encounter.finished',
                occurredAt: '2025-12-16T09:00:00.000Z',
                source: 'rules',
                detail: { code: 'detailVisitCompleted' },
              },
              {
                type: 'service_request.created',
                occurredAt: '2025-12-16T09:00:00.000Z',
                source: 'rules',
                detail: {
                  code: 'detailServiceRequestCreated',
                  params: {
                    testName: { kind: 'text', value: 'Hemoglobina glicosilada (HbA1c)' },
                    code: { kind: 'text', value: '4548-4' },
                    category: { kind: 'category', value: 'laboratory' },
                  },
                },
              },
            ],
            expectations: [
              {
                id: 'exp-old',
                ruleId: 'lab_order_result_pending',
                ruleVersion: '1',
                layer: 'universal',
                label: 'Resultado de laboratorio pendiente',
                status: 'superseded',
                dueAt: '2025-12-31T12:00:00.000Z',
                diff: 'superseded',
              },
              {
                id: 'exp-new',
                ruleId: 'lab_order_result_pending',
                ruleVersion: '1',
                layer: 'cadence',
                label: 'Dejó de venir a su control habitual',
                status: 'open',
                dueAt: '2026-01-20T09:00:00.000Z',
                diff: 'new',
              },
            ],
            autoCheck: {
              expected: { code: 'supSupersedeExpected' },
              observed: {
                code: 'supSupersedeObserved',
                params: {
                  oldStatus: { kind: 'status', value: 'superseded' },
                  dueDays: { kind: 'days', value: 15 },
                },
              },
              passed: true,
            },
          };
          return HttpResponse.json(outcome);
        }),
      ],
    });

    await screen.findByText('Una orden repetida reemplaza a la anterior');
    await rendered.user.click(screen.getByRole('button', { name: 'Empezar la prueba' }));
    await screen.findByText('Pide un examen');
    await rendered.user.click(screen.getByRole('button', { name: 'Cargar' }));

    await screen.findAllByText(/Reemplazada/);

    const body = document.body.textContent;
    // No raw ISO instant leaks into the rendered page.
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // No raw English status/category/layer words leak into the Spanish page.
    expect(body).not.toMatch(/\bsuperseded\b/i);
    expect(body).not.toMatch(/\blaboratory\b/i);
    expect(body).not.toMatch(/\bmissing\b/i);
    expect(body).not.toMatch(/\bStatus:/);
    expect(body).not.toMatch(/\bDue at\b/);
    expect(body).not.toMatch(/\bday\(s\)\b/);
    // The Spanish sentence itself came through, params and all.
    expect(body).toContain('Reemplazada');
    expect(body).toMatch(/Estado anterior: Reemplazada/);
    expect(body).toMatch(/15 días/);
    expect(body).toContain('Frecuencia de visitas');
  });
});
