import { createHmac } from 'node:crypto';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import {
  createRuntime,
  DEMO_CLINIC,
  type EngineRuntime,
  ensureLabClinicAndClock,
  labClinicId,
  LabClockRegistry,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';

const KEY = 'lab-records-test-key';
const CODE = 'lab-records-test-code';
const EMAIL = 'doctor@example.com';

/** Replicates `site.ts`'s private `evaluatorToken`: base64url(email) + '.' + HMAC-SHA256(secret, email). */
function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function harness(
  env: Record<string, string> = { DEMO_ACCESS_CODE: CODE },
): Promise<{ readonly app: App; readonly runtime: EngineRuntime }> {
  runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
  );
  const config = loadApiConfig(env);
  const { app } = createApiServer(runtime, config);
  return { app, runtime };
}

function authAndEvaluator(): Record<string, string> {
  const secret = deriveSessionSecret(CODE);
  return {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EMAIL, secret)}`,
    'content-type': 'application/json',
  };
}

/** Seeds a bare Patient in the evaluator's lab clinic, bypassing HTTP (structured records target an existing patient). */
async function seedLabPatient(theRuntime: EngineRuntime, patientId: string): Promise<string> {
  const { clinic, clock } = await ensureLabClinicAndClock(
    theRuntime,
    // A fresh registry just for seeding; the route handlers keep their own
    // (via the app's closure), but the clinic is idempotent and this call
    // only seeds a Patient resource, so a second clock instance is harmless.
    new LabClockRegistry(),
    EMAIL,
  );
  const bundle = buildConsultationBundle({
    consultationId: `seed-${patientId}`,
    patient: { id: patientId, name: 'Paciente de Prueba' },
    specialty: 'general_medicine',
    occurredAt: clock.now(),
    noteText: 'Seed note for the lab patient fixture.',
  });
  const acceptance = await theRuntime.ingestion.accept(clinic.id, bundle, 'sync');
  expect(acceptance.ok).toBe(true);
  return clinic.id;
}

describe('the evaluator lab: structured records', () => {
  it('rejects a structured record with no evaluator identity (no access gate configured)', async () => {
    // Without DEMO_ACCESS_CODE there is no gate at all, so `c.var.evaluatorEmail`
    // is never set by anything: the lab route must still refuse cleanly
    // rather than silently acting with no evaluator identity to attribute it to.
    const { app } = await harness({});
    const response = await app.request('/api/demo/lab/records', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        patientId: 'pat-1',
        recordDate: '2026-01-05',
        entry: { kind: 'visit' },
      }),
    });
    expect(response.status).toBe(403);
  });

  it('adds a lab order with no note and no LLM call, isolated in the evaluator lab clinic', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    const labId = await seedLabPatient(rt, patientId);
    expect(labId).toBe(labClinicId(EMAIL));
    // The shared demo clinic never sees this patient or this order.
    expect(await rt.storage.clinics.get(DEMO_CLINIC.id as never)).toBeDefined();

    const response = await app.request('/api/demo/lab/records', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        recordDate: '2026-01-05',
        entry: { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      patientId: string;
      clinicId: string;
      expectationsCreated: readonly { ruleId: string; status: string }[];
    };
    expect(body.clinicId).toBe(labId);
    expect(body.expectationsCreated.length).toBeGreaterThan(0);

    // The expectations read for the lab patient shows it, open, with a rule and a due date.
    const expectationsResponse = await app.request(
      `/api/demo/lab/patients/${patientId}/expectations`,
      { headers: authAndEvaluator() },
    );
    expect(expectationsResponse.status).toBe(200);
    const expectations = (await expectationsResponse.json()) as {
      items: readonly { ruleId: string; layer: string; status: string; dueAt: string }[];
    };
    expect(expectations.items.length).toBeGreaterThan(0);
    expect(expectations.items[0]?.status).toBe('open');
  });

  it('adds a prescription, a visit and a diagnosis with no note (encounter.finished, no LLM extraction)', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);

    for (const entry of [
      { kind: 'prescription' as const, text: 'Metformina 850mg', durationDays: 90 },
      { kind: 'visit' as const },
      { kind: 'diagnosis' as const, icd10: 'E11', display: 'Type 2 diabetes' },
    ]) {
      const response = await app.request('/api/demo/lab/records', {
        method: 'POST',
        headers: authAndEvaluator(),
        body: JSON.stringify({ patientId, recordDate: '2026-01-05', entry }),
      });
      expect(response.status, JSON.stringify(entry)).toBe(201);
    }
  });

  it("rejects a record dated after the lab clinic's own current date", async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);
    const response = await app.request('/api/demo/lab/records', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        recordDate: '2099-01-01',
        entry: { kind: 'visit' },
      }),
    });
    expect(response.status).toBe(422);
  });
});

describe('the evaluator lab: clock', () => {
  it("reports the lab clinic's own current date, starting at the shared clock's today", async () => {
    const { app, runtime: rt } = await harness();
    const response = await app.request('/api/demo/lab/clock', { headers: authAndEvaluator() });
    expect(response.status).toBe(200);
    const { now } = (await response.json()) as { now: string };
    expect(now).toBe(rt.clock.now().toISOString());
  });
});

describe('the evaluator lab: patients', () => {
  it('creates a fictitious patient and lists it with the right age and sex', async () => {
    const { app } = await harness();
    const created = await app.request('/api/demo/lab/patients', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({ name: 'Ana Pérez', sex: 'female', age: 40, specialty: 'diabetology' }),
    });
    expect(created.status).toBe(201);
    const patient = (await created.json()) as {
      id: string;
      name: string;
      sex?: string;
      age?: number;
    };
    expect(patient.name).toBe('Ana Pérez');
    expect(patient.sex).toBe('female');

    const listed = await app.request('/api/demo/lab/patients', { headers: authAndEvaluator() });
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as {
      items: { id: string; name: string; sex?: string; age?: number }[];
    };
    const found = items.find((item) => item.id === patient.id);
    expect(found?.name).toBe('Ana Pérez');
    expect(found?.sex).toBe('female');
    expect(found?.age).toBeGreaterThanOrEqual(39);
    expect(found?.age).toBeLessThanOrEqual(40);
  });
});

describe('the evaluator lab: documents', () => {
  it('reads a pasted document through the normal FHIR path and creates expectations', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);
    const response = await app.request('/api/demo/lab/documents', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        text: 'Paciente con DM2. Control en 3 meses con HbA1c.',
        documentDate: '2026-01-05',
        documentType: 'consultation_note',
      }),
    });
    const body = (await response.json()) as {
      patientId: string;
      extraction: { model: string; hasPlan: boolean; planItems: readonly unknown[] };
      expectationsCreated: readonly { ruleId: string; status: string }[];
    };
    expect(response.status).toBe(201);
    expect(body.patientId).toBe(patientId);
    expect(body.extraction.hasPlan).toBe(true);
    expect(body.extraction.planItems.length).toBeGreaterThan(0);
    expect(body.expectationsCreated.length).toBeGreaterThan(0);
  });

  it('creates a new patient inline when the upload carries `newPatient`', async () => {
    const { app } = await harness();
    const response = await app.request('/api/demo/lab/documents', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        newPatient: { name: 'Carlos Ruiz', sex: 'male', age: 55 },
        text: 'Consulta de control. Sin plan por ahora.',
        documentDate: '2026-01-05',
        documentType: 'consultation_note',
      }),
    });
    const body = (await response.json()) as { patientId: string };
    expect(response.status).toBe(201);
    const listed = await app.request('/api/demo/lab/patients', { headers: authAndEvaluator() });
    const { items } = (await listed.json()) as { items: { id: string; name: string }[] };
    expect(items.some((item) => item.id === body.patientId && item.name === 'Carlos Ruiz')).toBe(
      true,
    );
  });

  it('rejects an unsupported file type with a clear error', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);
    const response = await app.request('/api/demo/lab/documents', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        filename: 'note.exe',
        contentType: 'application/x-msdownload',
        dataBase64: Buffer.from('not a document').toString('base64'),
        documentDate: '2026-01-05',
        documentType: 'other',
      }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('lab_document_unsupported_type');
  });

  it('refuses an image with a clear "not supported yet" error', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);
    const response = await app.request('/api/demo/lab/documents', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        filename: 'scan.png',
        contentType: 'image/png',
        dataBase64: Buffer.from('fake png bytes').toString('base64'),
        documentDate: '2026-01-05',
        documentType: 'imaging_report',
      }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('lab_document_unsupported_image');
  });
});

describe('the evaluator lab: date impact and cases', () => {
  it('moves the lab clock forward, reports the impact and lists the opened case', async () => {
    const { app, runtime: rt } = await harness();
    const patientId = `pat-${Math.random().toString(36).slice(2, 8)}`;
    await seedLabPatient(rt, patientId);
    const order = await app.request('/api/demo/lab/records', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({
        patientId,
        recordDate: '2026-01-05',
        entry: { kind: 'order', loinc: '4548-4', display: 'HbA1c' },
      }),
    });
    expect(order.status).toBe(201);

    const past = await app.request('/api/demo/lab/date', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({ date: '2026-01-04' }),
    });
    expect(past.status).toBe(422);

    const advanced = await app.request('/api/demo/lab/date', {
      method: 'POST',
      headers: authAndEvaluator(),
      body: JSON.stringify({ date: '2026-04-15' }),
    });
    const impact = (await advanced.json()) as {
      expectationsExpired: number;
      casesOpened: number;
      casesEscalated: number;
    };
    expect(advanced.status).toBe(200);
    expect(impact.expectationsExpired + impact.casesOpened).toBeGreaterThan(0);

    const cases = await app.request('/api/demo/lab/cases', { headers: authAndEvaluator() });
    expect(cases.status).toBe(200);
    const { items } = (await cases.json()) as { items: readonly { patient: { id: string } }[] };
    expect(items.some((item) => item.patient.id === patientId)).toBe(true);
  });
});
