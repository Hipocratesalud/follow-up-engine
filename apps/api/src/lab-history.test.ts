import { createHmac } from 'node:crypto';
import {
  createRuntime,
  type EngineRuntime,
  labClinicId,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import type { LabHistoryImportResponse, LabHistorySampleSet } from './http/lab-schemas.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';

/*
 * V1-A "Import history" through the API (the Lab page's route): several
 * dated documents of one patient, replayed by the initial backfill in the
 * evaluator's own lab clinic. Fake provider; the scripted readers know the
 * committed sample set.
 */

const KEY = 'lab-history-test-key';
const CODE = 'lab-history-test-code';

function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function harness(): Promise<{ readonly app: App; readonly runtime: EngineRuntime }> {
  runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      DEMO_API_KEY: KEY,
      LLM_PROVIDER: 'fake',
      DATABASE_URL: '',
    }),
  );
  const { app } = createApiServer(runtime, loadApiConfig({ DEMO_ACCESS_CODE: CODE }));
  return { app, runtime };
}

function headers(email: string, json = true): Record<string, string> {
  return {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(email, deriveSessionSecret(CODE))}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function samples(app: App, email: string): Promise<LabHistorySampleSet> {
  const response = await app.request('/api/demo/lab/history/samples', { headers: headers(email) });
  expect(response.status).toBe(200);
  return (await response.json()) as LabHistorySampleSet;
}

async function importSample(
  app: App,
  email: string,
  setId: string,
): Promise<{ status: number; body: LabHistoryImportResponse }> {
  const set = (await samples(app, email)).sets.find((item) => item.id === setId);
  const response = await app.request('/api/demo/lab/history', {
    method: 'POST',
    headers: headers(email),
    body: JSON.stringify({
      newPatient: { name: set?.patient.name, sex: set?.patient.sex, age: set?.patient.age },
      documents: set?.documents,
    }),
  });
  return { status: response.status, body: (await response.json()) as LabHistoryImportResponse };
}

describe('POST /api/demo/lab/history', () => {
  it('imports the sample history: origin=backfill expectations, the HbA1c order closed by the imported report, the case released by the cap', async () => {
    const { app } = await harness();
    const email = 'doctor@example.com';
    const { status, body } = await importSample(app, email, 'rafael');
    expect(status).toBe(201);
    expect(body.clinicId).toBe(labClinicId(email));
    expect(body.documents.map((document) => document.status)).toEqual([
      'staged',
      'staged',
      'staged',
      'staged',
    ]);
    expect(body.documents[1]?.results?.[0]).toMatchObject({ test: 'HbA1c', interpretation: 'H' });
    expect(body.documents[3]?.reading?.model).toBe('fake:fake-vision');
    expect(body.backfill.release?.perDay).toEqual([1]);
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0]?.released).toBe(true);
    // Two reports read (the PDF's text and the photo), two notes read by the extractor.
    expect(body.llm.calls).toBe(4);

    const expectations = (await (
      await app.request(`/api/demo/lab/patients/${body.patientId}/expectations`, {
        headers: headers(email),
      })
    ).json()) as {
      items: { label: string; status: string; origin: string; closedReasonLabel?: string }[];
    };
    expect(expectations.items.every((item) => item.origin === 'backfill')).toBe(true);
    expect(
      expectations.items.some(
        (item) => item.status === 'fulfilled' && item.closedReasonLabel === 'The result arrived',
      ),
    ).toBe(true);

    // The lab patient is listed under its name.
    const patients = (await (
      await app.request('/api/demo/lab/patients', { headers: headers(email) })
    ).json()) as { items: { id: string; name: string }[] };
    expect(patients.items).toContainEqual(
      expect.objectContaining({ id: body.patientId, name: 'Rafael Antonio Méndez' }),
    );
  });

  it('holds the second patient in the lab’s To recover until the next day (cap of one a day)', async () => {
    const { app } = await harness();
    const email = 'doctor@example.com';
    await importSample(app, email, 'rafael');
    const carmen = await importSample(app, email, 'carmen');
    expect(carmen.body.cases.map((item) => item.released)).toEqual([false]);

    const recovery = (await (
      await app.request('/api/demo/lab/recovery', { headers: headers(email) })
    ).json()) as { items: { patient: { name: string }; origin: string }[]; total: number };
    expect(recovery.total).toBe(1);
    expect(recovery.items[0]?.patient.name).toBe('Carmen Elena Rivas');
    expect(recovery.items[0]?.origin).toBe('backfill');

    const clock = (await (
      await app.request('/api/demo/lab/clock', { headers: headers(email) })
    ).json()) as { now: string };
    const tomorrow = new Date(Date.parse(clock.now) + 86_400_000).toISOString().slice(0, 10);
    expect(
      (
        await app.request('/api/demo/lab/date', {
          method: 'POST',
          headers: headers(email),
          body: JSON.stringify({ date: tomorrow }),
        })
      ).status,
    ).toBe(200);
    const after = (await (
      await app.request('/api/demo/lab/recovery', { headers: headers(email) })
    ).json()) as { total: number };
    expect(after.total).toBe(0);
  });

  it('accepts multipart: one files part per document and their dates and types in order', async () => {
    const { app } = await harness();
    const email = 'doctor@example.com';
    const set = (await samples(app, email)).sets.find((item) => item.id === 'rafael');
    const form = new FormData();
    form.set('newPatient', JSON.stringify({ name: 'Rafael Antonio Méndez' }));
    form.set(
      'documents',
      JSON.stringify(
        (set?.documents ?? []).map((document) => ({
          documentDate: document.documentDate,
          documentType: document.documentType,
        })),
      ),
    );
    for (const document of set?.documents ?? []) {
      form.append(
        'files',
        new File([Buffer.from(document.dataBase64, 'base64')], document.filename, {
          type: document.contentType,
        }),
      );
    }
    const response = await app.request('/api/demo/lab/history', {
      method: 'POST',
      headers: headers(email, false),
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as LabHistoryImportResponse;
    expect(body.documents.map((document) => document.readAs)).toEqual([
      'note',
      'lab_report',
      'note',
      'lab_report',
    ]);

    const mismatch = new FormData();
    mismatch.set('patientId', body.patientId);
    mismatch.set('documents', JSON.stringify([]));
    mismatch.append('files', new File(['x'], 'note.txt', { type: 'text/plain' }));
    const refused = await app.request('/api/demo/lab/history', {
      method: 'POST',
      headers: headers(email, false),
      body: mismatch,
    });
    expect(refused.status).toBe(422);
  });

  it('is idempotent over HTTP: the same documents again create nothing', async () => {
    const { app } = await harness();
    const email = 'doctor@example.com';
    const first = await importSample(app, email, 'rafael');
    const set = (await samples(app, email)).sets.find((item) => item.id === 'rafael');
    const again = await app.request('/api/demo/lab/history', {
      method: 'POST',
      headers: headers(email),
      body: JSON.stringify({ patientId: first.body.patientId, documents: set?.documents }),
    });
    const body = (await again.json()) as LabHistoryImportResponse;
    expect(body.eventsStaged).toBe(0);
    expect(body.backfill.expectationsCreated).toBe(0);
    expect(body.llm.calls).toBe(0);
    expect(body.documents.every((document) => document.status === 'already_imported')).toBe(true);
  });

  it('refuses a document dated after the lab’s date, and every request without an evaluator', async () => {
    const { app } = await harness();
    const email = 'doctor@example.com';
    const set = (await samples(app, email)).sets.find((item) => item.id === 'carmen');
    const future = await app.request('/api/demo/lab/history', {
      method: 'POST',
      headers: headers(email),
      body: JSON.stringify({
        newPatient: { name: 'Futuro' },
        documents: set?.documents.map((document) => ({ ...document, documentDate: '2099-01-01' })),
      }),
    });
    expect(future.status).toBe(422);
    const anonymous = await app.request('/api/demo/lab/history', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ newPatient: { name: 'X' }, documents: set?.documents }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('keeps evaluators apart: one lab’s import never shows in another lab', async () => {
    const { app } = await harness();
    const imported = await importSample(app, 'a@example.com', 'rafael');
    await importSample(app, 'a@example.com', 'carmen');
    const other = 'b@example.com';
    const recovery = (await (
      await app.request('/api/demo/lab/recovery', { headers: headers(other) })
    ).json()) as { total: number };
    expect(recovery.total).toBe(0);
    const expectations = (await (
      await app.request(`/api/demo/lab/patients/${imported.body.patientId}/expectations`, {
        headers: headers(other),
      })
    ).json()) as { items: unknown[] };
    expect(expectations.items).toHaveLength(0);
    const patients = (await (
      await app.request('/api/demo/lab/patients', { headers: headers(other) })
    ).json()) as { items: unknown[] };
    expect(patients.items).toHaveLength(0);
  });

  it('is documented in /openapi.json', async () => {
    const { app } = await harness();
    const doc = (await (
      await app.request('/openapi.json', { headers: headers('doctor@example.com') })
    ).json()) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths['/api/demo/lab/history']?.['post']).toBeDefined();
    expect(doc.paths['/api/demo/lab/history/samples']?.['get']).toBeDefined();
    expect(doc.paths['/api/demo/lab/recovery']?.['get']).toBeDefined();
    expect(doc.components.schemas['LabHistoryImport']).toBeDefined();
    expect(doc.components.schemas['LabHistoryImportResponse']).toBeDefined();
  });
});
