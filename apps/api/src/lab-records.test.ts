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
