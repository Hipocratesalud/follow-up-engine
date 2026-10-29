import { createHmac } from 'node:crypto';
import {
  createRuntime,
  type EngineRuntime,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_TESTS } from './http/engine-tests-catalog.ts';
import type { App } from './http/context.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { loadApiConfig } from './config.ts';
import { createApiServer } from './server.ts';

const KEY = 'engine-tests-key';
const CODE = 'engine-tests-access-code';
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

async function harness(): Promise<{ readonly app: App }> {
  runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
  );
  const config = loadApiConfig({ DEMO_ACCESS_CODE: CODE });
  const { app } = createApiServer(runtime, config);
  return { app };
}

function headers(): Record<string, string> {
  const secret = deriveSessionSecret(CODE);
  return {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EMAIL, secret)}`,
    'content-type': 'application/json',
  };
}

interface RunResponse {
  readonly id: string;
  readonly patientId: string;
  readonly supported: boolean;
  readonly autoCheck: { readonly expected: string; readonly observed: string; readonly passed: boolean };
  readonly timeline: readonly unknown[];
  readonly expectations: readonly unknown[];
}

describe('the engine tests page: catalog', () => {
  it('lists every scenario with a progress count, and reflects a verdict', async () => {
    const { app } = await harness();
    const before = await app.request('/api/demo/engine-tests', { headers: headers() });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      items: readonly { id: string; reviewed: boolean }[];
      progress: { reviewed: number; total: number };
    };
    expect(beforeBody.items).toHaveLength(ENGINE_TESTS.length);
    expect(beforeBody.progress.total).toBe(ENGINE_TESTS.length);
    expect(beforeBody.progress.reviewed).toBe(0);

    const scenarioId = ENGINE_TESTS[0]?.id ?? '';
    const verdict = await app.request(`/api/demo/engine-tests/${scenarioId}/verdict`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ verdict: 'works_as_expected', autoCheckPassed: true }),
    });
    expect(verdict.status).toBe(201);

    const after = await app.request('/api/demo/engine-tests', { headers: headers() });
    const afterBody = (await after.json()) as { progress: { reviewed: number; total: number } };
    expect(afterBody.progress.reviewed).toBe(1);
  });

  it('refuses without an evaluator identity', async () => {
    runtime = await createRuntime(
      loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
    );
    const { app } = createApiServer(runtime, loadApiConfig({}));
    const response = await app.request('/api/demo/engine-tests', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(403);
  });
});

describe.each(ENGINE_TESTS)('engine test: $id', (def) => {
  it('runs against the real engine (memory runtime) and the automatic check passes', async () => {
    const { app } = await harness();
    const response = await app.request(`/api/demo/engine-tests/${def.id}/run`, {
      method: 'POST',
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunResponse;
    expect(body.supported, body.autoCheck.observed).toBe(true);
    expect(body.autoCheck.passed, `${body.autoCheck.expected} :: ${body.autoCheck.observed}`).toBe(
      true,
    );
    expect(body.patientId.length).toBeGreaterThan(0);
  });
});
