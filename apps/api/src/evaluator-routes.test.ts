import { createHmac } from 'node:crypto';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';
import { seedSyntheticClinic } from './test/seed.ts';

const KEY = 'evaluator-routes-test-key';
const CODE = 'evaluator-routes-test-code';
// Physicians: not at a test domain (example.com is a test account, below).
const ALICE = 'alice@clinica-norte.test';
const BOB = 'bob@clinica-norte.test';
const QA = 'qa-bot@example.com';
const ORCHESTRATOR = 'evidence-orchestrator@example.com';

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
      'occurredAt,simulatedAt,evaluatorEmail,is_test_evaluator,action,clinicId,entityType,entityId,patientId,payload',
    );
    expect(lines.some((line) => line.includes(ALICE) && line.includes('login'))).toBe(true);
  });
});

describe('the hosted demo: test and QA accounts', () => {
  it('keeps them out of the Evaluators summary, lists them apart, and flags their rows in the log and CSV', async () => {
    const { app } = await harness();
    await login(app, ALICE);
    await login(app, QA);
    await login(app, ORCHESTRATOR);

    const summary = (await (
      await app.request('/api/demo/evaluators', { headers: headersFor(ALICE) })
    ).json()) as {
      items: { evaluatorEmail: string }[];
      testEvaluators: { evaluatorEmail: string; total: number }[];
    };
    expect(summary.items.map((item) => item.evaluatorEmail)).toEqual([ALICE]);
    expect(summary.testEvaluators.map((item) => item.evaluatorEmail).sort()).toEqual(
      [ORCHESTRATOR, QA].sort(),
    );

    const log = (await (
      await app.request('/api/demo/evaluator-events', { headers: headersFor(ALICE) })
    ).json()) as { items: { evaluatorEmail: string; isTestEvaluator: boolean }[] };
    expect(log.items).toHaveLength(3);
    for (const item of log.items) {
      expect(item.isTestEvaluator).toBe(item.evaluatorEmail !== ALICE);
    }

    const csv = await (
      await app.request('/api/demo/evaluator-events?format=csv', { headers: headersFor(ALICE) })
    ).text();
    const rows = csv.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.includes(ALICE))).toContain(`${ALICE},false,login`);
    expect(rows.find((row) => row.includes(QA))).toContain(`${QA},true,login`);
    expect(rows.find((row) => row.includes(ORCHESTRATOR))).toContain(`${ORCHESTRATOR},true,login`);
  });

  it("leaves a test account's verdict out of the inbox usefulness and the clinic metrics", async () => {
    const { app } = await harness();
    if (runtime === undefined) throw new Error('no runtime');
    await seedSyntheticClinic(runtime, { apiKey: KEY, patients: 30 });
    const cases = (await (
      await app.request('/api/inbox/cases?limit=2', { headers: headersFor(ALICE) })
    ).json()) as { items: { id: string }[] };
    const [first, second] = cases.items;
    if (first === undefined || second === undefined) throw new Error('no cases to rate');
    const rate = (email: string, id: string, useful: boolean) =>
      app.request(`/api/inbox/cases/${id}/feedback`, {
        method: 'POST',
        headers: headersFor(email),
        body: JSON.stringify(useful ? { useful } : { useful, reason: 'other' }),
      });
    expect((await rate(ALICE, first.id, true)).ok).toBe(true);
    // The test accounts: one rates another case, one overrides Alice's verdict.
    expect((await rate(QA, second.id, false)).ok).toBe(true);
    expect((await rate(ORCHESTRATOR, first.id, false)).ok).toBe(true);

    const stats = (await (
      await app.request('/api/inbox/stats', { headers: headersFor(ALICE) })
    ).json()) as { feedback: { total: number; usefulRate: number } };
    expect(stats.feedback).toEqual({ total: 1, usefulRate: 1 });

    const metrics = (await (
      await app.request('/api/inbox/metrics', { headers: headersFor(ALICE) })
    ).json()) as { feedback: { casesWithFeedback: number; useful: number } };
    expect(metrics.feedback).toMatchObject({ casesWithFeedback: 1, useful: 1 });
  });
});
