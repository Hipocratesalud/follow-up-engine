import { readFileSync } from 'node:fs';
import {
  createRuntime,
  type EngineRuntime,
  loadRuntimeConfig,
  verifyWebhookSignature,
} from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './http/context.ts';
import type {
  CaseDetail,
  CaseView,
  ConditionView,
  InboxStats,
  PatientDetail,
} from './http/schemas.ts';
import { createApiServer } from './server.ts';

const BUNDLE = readFileSync(
  new URL('../../../packages/fhir/fixtures/bundles/consultation-diabetology.json', import.meta.url),
  'utf8',
);
const INVALID = readFileSync(
  new URL('../../../packages/fhir/fixtures/bundles/invalid-consultation.json', import.meta.url),
  'utf8',
);
const PATIENT = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01';
const KEY_A = 'key-clinic-a';
const KEY_B = 'key-clinic-b';

interface Harness {
  readonly runtime: EngineRuntime;
  readonly app: App;
  // The response body is JSON the test asserts on: callers name its shape.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  call<T>(
    path: string,
    init?: { method?: string; body?: unknown; key?: string; fhir?: boolean },
  ): Promise<{
    status: number;
    body: T;
    headers: Headers;
  }>;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY_A, ...env }),
  );
  await runtime.registerClinic({ id: 'clinic-b', name: 'Clínica B', apiKey: KEY_B });
  const { app } = createApiServer(runtime, { port: 0, embeddedWorker: false, corsOrigins: [] });
  return {
    runtime,
    app,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    async call<T>(
      path: string,
      init: { method?: string; body?: unknown; key?: string; fhir?: boolean } = {},
    ) {
      const headers: Record<string, string> = {};
      if (init.key !== '') {
        headers['authorization'] = `Bearer ${init.key ?? KEY_A}`;
      }
      if (init.body !== undefined) {
        headers['content-type'] = init.fhir === true ? 'application/fhir+json' : 'application/json';
      }
      const response = await app.request(path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text === '' ? undefined : JSON.parse(text)) as T,
        headers: response.headers,
      };
    },
  };
}

describe('API over the memory runtime', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.runtime.close();
  });

  it('serves health, readiness and the OpenAPI document without a key', async () => {
    expect((await h.call('/healthz', { key: '' })).status).toBe(200);
    expect((await h.call<{ storage: string }>('/readyz', { key: '' })).body.storage).toBe('memory');
    const doc = await h.call<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>('/openapi.json', { key: '' });
    expect(doc.body.openapi).toBe('3.1.0');
    expect(Object.keys(doc.body.paths)).toContain('/api/inbox/cases/{id}/actions');
    expect(Object.keys(doc.body.components.schemas)).toContain('CaseDetail');
  });

  it('rejects requests without a key or with an unknown key', async () => {
    const missing = await h.call<{ error: { code: string } }>('/api/inbox/cases', { key: '' });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('unauthorized');
    const wrong = await h.call<{ resourceType: string }>('/fhir/Task', { key: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.resourceType).toBe('OperationOutcome');
  });

  it('answers an invalid Bundle with a 400 OperationOutcome and stores nothing', async () => {
    const response = await h.call<{ resourceType: string; issue: { severity: string }[] }>(
      '/fhir',
      {
        body: INVALID,
        fhir: true,
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.resourceType).toBe('OperationOutcome');
    expect(response.body.issue.some((issue) => issue.severity === 'error')).toBe(true);
    expect(response.headers.get('content-type')).toMatch(/application\/fhir\+json/);
  });

  it('accepts a Bundle asynchronously by default (202 + job id)', async () => {
    const response = await h.call<{ type: string }>('/fhir', { body: BUNDLE, fhir: true });
    expect(response.status).toBe(202);
    expect(response.body.type).toBe('transaction-response');
    expect(response.headers.get('x-followup-job')).toBeTruthy();
  });

  it('runs the whole loop: sync ingest, Tasks, a case with evidence, actions, feedback, webhooks', async () => {
    const ingested = await h.call('/fhir?sync=true', { body: BUNDLE, fhir: true });
    expect(ingested.status).toBe(200);

    const tasks = await h.call<{ entry: { resource: { code: { coding: { code: string }[] } } }[] }>(
      `/fhir/Task?patient=Patient/${PATIENT}&status=requested`,
    );
    const rules = tasks.body.entry.map((entry) => entry.resource.code.coding[0]?.code);
    expect(rules).toEqual(
      expect.arrayContaining(['lab_order_result_pending', 'doctor_plan_followup']),
    );

    expect((await h.call('/api/demo/clock/advance', { body: { days: 92 } })).status).toBe(200);
    const page = await h.call<{ items: CaseView[] }>('/api/inbox/cases');
    const planCase = page.body.items.find((item) =>
      item.reasons.some((reason) => reason.layer === 'doctor_plan'),
    );
    expect(planCase).toBeDefined();
    const reason = planCase?.reasons.find((item) => item.layer === 'doctor_plan');
    expect(reason?.evidence?.quote).toMatch(/control en 3 meses/i);
    expect(reason?.label).not.toMatch(/\d/);
    expect(planCase?.assignee).toBe('Dr. Luis Sintético');
    expect(planCase?.patient).toMatchObject({ name: 'Ana Prueba', sex: 'female', age: 58 });

    const caseId = planCase?.id ?? '';
    const detail = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`);
    expect(detail.body.reasons[0]?.evidence?.noteExcerpt).toContain('Plan:');
    expect(detail.body.timeline[0]?.label).toMatch(/^Caso abierto/);

    const snoozed = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'snooze', snoozeDays: 3 },
    });
    expect(snoozed.body.status).toBe('snoozed');
    const contacted = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'notify' },
    });
    expect(contacted.body.status).toBe('notified');
    expect(contacted.body.timeline.slice(-2)).toMatchObject([
      { type: 'patient_contact_requested', actor: { type: 'user', id: 'inbox-user' } },
      { type: 'notified', actor: { type: 'user', id: 'inbox-user' } },
    ]);
    // The contact window: a second request within days is refused by the engine.
    const again = await h.call<{ error: { code: string } }>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'notify' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('patient_contact_not_allowed');
    const resolved = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'resolve', note: 'Agendado por teléfono' },
    });
    expect(resolved.body.status).toBe('resolved');
    const invalid = await h.call<{ error: { code: string } }>(
      `/api/inbox/cases/${caseId}/actions`,
      {
        body: { action: 'snooze', snoozeDays: 2 },
      },
    );
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe('invalid_transition');

    const noReason = await h.call(`/api/inbox/cases/${caseId}/feedback`, {
      body: { useful: false },
    });
    expect(noReason.status).toBe(422);
    const feedback = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/feedback`, {
      body: { useful: true, comment: 'Bien detectado' },
    });
    expect(feedback.body.feedback).toEqual({ useful: true, comment: 'Bien detectado' });
    expect(feedback.body.timeline.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['opened', 'snoozed', 'resolved', 'feedback_recorded']),
    );

    const webhooks = await h.call<{
      items: { type: string; signatureValid: boolean; payload: unknown }[];
    }>('/api/demo/webhooks?limit=50');
    expect(webhooks.body.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(['case.opened', 'patient_contact.requested', 'case.resolved']),
    );
    expect(webhooks.body.items.every((item) => item.signatureValid)).toBe(true);
    expect(JSON.stringify(webhooks.body.items)).not.toMatch(/diabetes|HbA1c|metformina/i);
    const opened = await h.call<{ items: { type: string }[] }>(
      '/api/demo/webhooks?type=case.opened',
    );
    expect(opened.body.items.length).toBeGreaterThan(0);
    expect(opened.body.items.every((item) => item.type === 'case.opened')).toBe(true);

    const stats = await h.call<InboxStats>('/api/inbox/stats');
    expect(stats.body.llm).toMatchObject({ provider: 'fake', model: 'fake-extractor' });
    expect(stats.body.feedback).toEqual({ total: 1, usefulRate: 1 });
  });

  it('shows a patient with conditions, lets the clinician reject one, and finds patients by name', async () => {
    await h.call('/fhir?sync=true', { body: BUNDLE, fhir: true });
    const patient = await h.call<PatientDetail>(`/api/inbox/patients/${PATIENT}`);
    expect(patient.body.patient).toMatchObject({ name: 'Ana Prueba', birthDate: '1967-08-14' });
    // The note's "DM2" is already recorded (E11.9): no probable duplicate to review.
    expect(patient.body.conditions.map((item) => item.status)).not.toContain('probable');
    const consultation = await h.call<{
      bundle: { entry: { resource: { resourceType: string; id: string } }[] };
    }>('/api/demo/consultations', {
      body: {
        patientName: 'Luis Demo',
        specialty: 'internal_medicine',
        noteText: 'Paciente con HTA de reciente diagnóstico. Plan: control en 1 mes.',
      },
    });
    const demoPatient = consultation.body.bundle.entry.find(
      (entry) => entry.resource.resourceType === 'Patient',
    )?.resource.id;
    const inferred = await h.call<PatientDetail>(`/api/inbox/patients/${demoPatient ?? ''}`);
    const probable = inferred.body.conditions.find((item) => item.status === 'probable');
    expect(probable?.evidence?.quote).toBeDefined();
    const rejected = await h.call<ConditionView>(
      `/api/inbox/conditions/${encodeURIComponent(probable?.id ?? '')}/reject`,
      { method: 'POST' },
    );
    expect(rejected.body.status).toBe('rejected');

    const found = await h.call<{ items: { id: string; name: string }[] }>(
      '/api/inbox/patients?query=ana',
    );
    expect(found.body.items).toEqual([
      expect.objectContaining({ id: PATIENT, name: 'Ana Prueba' }),
    ]);
    expect((await h.call('/api/inbox/patients/unknown')).status).toBe(404);
    expect((await h.call<{ id: string }>('/api/inbox/clinic')).body.id).toBe('clinic-demo');
  });

  it('keeps clinics apart: clinic B sees none of clinic A', async () => {
    await h.call('/fhir?sync=true', { body: BUNDLE, fhir: true });
    await h.call('/api/demo/clock/advance', { body: { days: 20 } });
    const mine = await h.call<{ items: CaseView[] }>('/api/inbox/cases');
    const caseId = mine.body.items[0]?.id ?? '';
    expect(caseId).not.toBe('');
    expect(
      (await h.call<{ items: CaseView[] }>('/api/inbox/cases', { key: KEY_B })).body.items,
    ).toEqual([]);
    expect((await h.call(`/api/inbox/cases/${caseId}`, { key: KEY_B })).status).toBe(404);
    expect((await h.call(`/fhir/Task/${caseId}`, { key: KEY_B })).status).toBe(404);
    expect((await h.call(`/api/inbox/patients/${PATIENT}`, { key: KEY_B })).status).toBe(404);
  });

  it('builds, ingests and explains a demo consultation', async () => {
    const noteText = 'Paciente con DM2. Plan: control en 3 meses con HbA1c.';
    const response = await h.call<{
      extraction: { hasPlan: boolean; planItems: { evidenceQuote: string }[] };
      expectationsCreated: { ruleId: string; label: string }[];
    }>('/api/demo/consultations', {
      body: {
        patientName: 'Paciente Demo',
        specialty: 'diabetology',
        noteText,
        orders: [{ loinc: '4548-4', display: 'HbA1c' }],
      },
    });
    expect(response.status).toBe(201);
    expect(response.body.extraction.hasPlan).toBe(true);
    const quote = response.body.extraction.planItems[0]?.evidenceQuote ?? '';
    expect(quote).toMatch(/3 meses/);
    expect(noteText).toContain(quote);
    expect(response.body.expectationsCreated.map((item) => item.ruleId)).toContain(
      'lab_order_result_pending',
    );
  });
});

describe('API on a real clock', () => {
  it('has no demo endpoints', async () => {
    const h = await harness({ CLOCK: 'system' });
    // The demo clinic is not registered on a real clock: clinic B's key.
    expect((await h.call('/api/demo/clock', { key: KEY_B })).status).toBe(404);
    expect(
      (await h.call('/api/demo/clock/advance', { body: { days: 1 }, key: KEY_B })).status,
    ).toBe(404);
    await h.runtime.close();
  });
});

describe('webhook verification helper', () => {
  it('is exported for hosts and tests', () => {
    expect(verifyWebhookSignature('s', { rawBody: '{}', signature: undefined })).toBe(false);
  });
});
