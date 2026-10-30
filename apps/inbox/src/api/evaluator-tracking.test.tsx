import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render.tsx';
import { trackedPageOf } from './evaluator-tracking.ts';

describe('which page a path is, for the evaluator log', () => {
  it('names each tracked page, a patient page with its patient', () => {
    expect(trackedPageOf('/inbox')).toEqual({ page: 'inbox' });
    expect(trackedPageOf('/inbox/case-1')).toEqual({ page: 'inbox' });
    expect(trackedPageOf('/lab')).toEqual({ page: 'lab' });
    expect(trackedPageOf('/agent')).toEqual({ page: 'agent' });
    expect(trackedPageOf('/value')).toEqual({ page: 'value' });
    expect(trackedPageOf('/engine-tests')).toEqual({ page: 'engine_tests' });
    expect(trackedPageOf('/clinical-review/f-1')).toEqual({ page: 'clinical_review' });
    expect(trackedPageOf('/patients/pat-001')).toEqual({ page: 'patient', patientId: 'pat-001' });
    expect(trackedPageOf('/labs')).toBeUndefined();
    expect(trackedPageOf('/cases/c-1')).toBeUndefined();
  });
});

describe('page views in the evaluator log', () => {
  function handlers(email: string | undefined, sent: unknown[]) {
    return () => [
      http.get('*/api/evaluator/me', () => HttpResponse.json(email === undefined ? {} : { email })),
      http.post('*/api/evaluator/events', async ({ request }) => {
        sent.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }

  it('reports the page an evaluator opens, once', async () => {
    const sent: unknown[] = [];
    renderApp('/value', { handlers: handlers('dra.rojas@clinica.test', sent) });
    await waitFor(() => {
      expect(sent).toEqual([{ action: 'page_viewed', page: 'value' }]);
    });
    await screen.findAllByRole('heading', { level: 1 });
    expect(sent).toHaveLength(1);
  });

  it('reports nothing without an evaluator (no access gate)', async () => {
    const sent: unknown[] = [];
    renderApp('/value', { handlers: handlers(undefined, sent) });
    await screen.findAllByRole('heading', { level: 1 });
    expect(sent).toEqual([]);
  });
});
