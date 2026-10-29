import { createHmac } from 'node:crypto';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';

const KEY = 'evaluator-routes-test-key';
const CODE = 'evaluator-routes-test-code';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function harness(): Promise<{ readonly app: App }> {
  runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
  );
  const config = loadApiConfig({ DEMO_ACCESS_CODE: CODE });
  const { app } = createApiServer(runtime, config);
  return { app };
}

function headersFor(email: string): Record<string, string> {
  const secret = deriveSessionSecret(CODE);
  return {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(email, secret)}`,
    'content-type': 'application/json',
  };
}

/** Logs an evaluator in through the real gate, so `login` and a real timestamp land in the log. */
async function login(app: App, email: string): Promise<void> {
  const response = await app.request('/_access', {
    method: 'POST',
    body: new URLSearchParams({ code: CODE, email }),
  });
  expect(response.status).toBe(303);
}

describe('the hosted demo: evaluators admin page', () => {
  it('summarizes each evaluator (last seen, counts by action)', async () => {
    const { app } = await harness();
    await login(app, ALICE);
    await login(app, BOB);
    await login(app, ALICE);
    await app.request('/api/demo/lab/patients', {
      method: 'POST',
      headers: headersFor(ALICE),
      body: JSON.stringify({ name: 'Paciente de Ana' }),
    });

    const response = await app.request('/api/demo/evaluators', { headers: headersFor(ALICE) });
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as {
      items: { evaluatorEmail: string; total: number; byAction: Record<string, number> }[];
    };
    const alice = items.find((item) => item.evaluatorEmail === ALICE);
    const bob = items.find((item) => item.evaluatorEmail === BOB);
    expect(alice?.byAction['login']).toBe(2);
    expect(alice?.byAction['lab_patient_created']).toBe(1);
    expect(bob?.byAction['login']).toBe(1);
  });

  it('lists the chronological activity log, newest first, filterable by evaluator', async () => {
    const { app } = await harness();
    await login(app, ALICE);
    await login(app, BOB);

    const all = await app.request('/api/demo/evaluator-events', { headers: headersFor(ALICE) });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { items: { evaluatorEmail: string }[]; total: number };
    expect(allBody.total).toBeGreaterThanOrEqual(2);
    // Newest first: the last login (Bob) comes before the first (Alice).
    expect(allBody.items[0]?.evaluatorEmail).toBe(BOB);

    const onlyAlice = await app.request(
      `/api/demo/evaluator-events?evaluatorEmail=${encodeURIComponent(ALICE)}`,
      { headers: headersFor(ALICE) },
    );
    const aliceBody = (await onlyAlice.json()) as { items: { evaluatorEmail: string }[] };
    expect(aliceBody.items.every((item) => item.evaluatorEmail === ALICE)).toBe(true);
  });

  it('exports the log as CSV', async () => {
    const { app } = await harness();
    await login(app, ALICE);
    const response = await app.request('/api/demo/evaluator-events?format=csv', {
      headers: headersFor(ALICE),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('evaluator-events.csv');
    const csv = await response.text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'occurredAt,simulatedAt,evaluatorEmail,action,clinicId,entityType,entityId,patientId,payload',
    );
    expect(lines.some((line) => line.includes(ALICE) && line.includes('login'))).toBe(true);
  });
});
