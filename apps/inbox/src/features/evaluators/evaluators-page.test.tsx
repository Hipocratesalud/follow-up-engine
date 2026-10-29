import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';

const EVALUATOR_EMAIL = 'doctor@example.com';

function evaluatorsHandlers() {
  return [
    http.get('*/api/evaluator/me', () => HttpResponse.json({ email: EVALUATOR_EMAIL })),
    http.get('*/api/demo/evaluators', () =>
      HttpResponse.json({
        items: [
          {
            evaluatorEmail: EVALUATOR_EMAIL,
            firstSeenAt: '2026-01-05T09:00:00.000Z',
            lastSeenAt: '2026-01-05T10:00:00.000Z',
            total: 3,
            byAction: { login: 1, lab_patient_created: 2 },
          },
        ],
      }),
    ),
    http.get('*/api/demo/evaluator-events', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('format') === 'csv') {
        return new HttpResponse('occurredAt,evaluatorEmail,action\r\n2026-01-05,doctor,login', {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="evaluator-events.csv"',
          },
        });
      }
      return HttpResponse.json({
        items: [
          {
            id: 'evt-1',
            clinicId: 'clinic-demo',
            evaluatorEmail: EVALUATOR_EMAIL,
            action: 'login',
            simulatedAt: '2026-01-05T00:00:00.000Z',
            occurredAt: '2026-01-05T10:00:00.000Z',
          },
          {
            id: 'evt-2',
            clinicId: 'lab-abc',
            evaluatorEmail: EVALUATOR_EMAIL,
            action: 'lab_patient_created',
            entityId: 'pat-lab-1',
            simulatedAt: '2026-01-05T00:00:00.000Z',
            occurredAt: '2026-01-05T10:05:00.000Z',
          },
        ],
        total: 2,
      });
    }),
  ];
}

describe('the Evaluators page', () => {
  it('shows the per-evaluator summary and the chronological activity log', async () => {
    renderApp('/evaluators', { handlers: evaluatorsHandlers });

    const table = await screen.findByRole('table');
    expect(within(table).getByText(EVALUATOR_EMAIL)).toBeInTheDocument();
    expect(within(table).getByText('3')).toBeInTheDocument();
    expect(within(table).getByText(/Logged in · 1/)).toBeInTheDocument();
    expect(within(table).getByText(/Created a lab patient · 2/)).toBeInTheDocument();

    await screen.findByText('pat-lab-1');
    expect(screen.getAllByText('Created a lab patient').length).toBeGreaterThan(0);
  });

  it('downloads the activity log as CSV when asked', async () => {
    const rendered = renderApp('/evaluators', { handlers: evaluatorsHandlers });
    await screen.findByRole('table');

    // jsdom does not implement these: assign them directly rather than
    // replacing the whole `URL` global (which would also lose its
    // constructor, breaking every other `new URL(...)` in the app).
    const createObjectUrl = vi.fn(() => 'blob:mock-url');
    const revokeObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;
    URL.revokeObjectURL = revokeObjectUrl;

    await rendered.user.click(screen.getByRole('button', { name: /Download CSV/i }));

    await vi.waitFor(() => {
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
    });
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:mock-url');
  });
});
