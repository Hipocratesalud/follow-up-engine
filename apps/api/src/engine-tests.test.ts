import { createHmac } from 'node:crypto';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_TESTS } from './http/engine-tests-catalog.ts';
import type { App } from './http/context.ts';
import type { EngineTestStepValue } from './http/engine-tests-schemas.ts';
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

interface StartResponse {
  readonly id: string;
  readonly patientId: string;
  readonly day0: string;
  readonly steps: readonly {
    readonly step: number;
    readonly action: string;
    readonly suggestion: EngineTestStepValue;
  }[];
}

interface StepResponse {
  readonly id: string;
  readonly patientId: string;
  readonly step: number;
  readonly timeline: readonly unknown[];
  readonly expectations: readonly unknown[];
  readonly autoCheck: {
    readonly expected: string;
    readonly observed: string;
    readonly passed: boolean;
  };
  readonly ruleCard?: unknown;
}

/** Starts a scenario and walks every one of its steps with the server's own suggestions, unedited. */
async function walkWithDefaults(
  app: App,
  scenarioId: string,
): Promise<{ readonly start: StartResponse; readonly results: readonly StepResponse[] }> {
  const startResponse = await app.request(`/api/demo/engine-tests/${scenarioId}/start`, {
    method: 'POST',
    headers: headers(),
  });
  expect(startResponse.status, await startResponse.clone().text()).toBe(200);
  const start = (await startResponse.json()) as StartResponse;
  const results: StepResponse[] = [];
  for (const step of start.steps) {
    const response = await app.request(
      `/api/demo/engine-tests/${scenarioId}/steps/${String(step.step)}`,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          day0: start.day0,
          patientId: start.patientId,
          value: step.suggestion,
        }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    results.push((await response.json()) as StepResponse);
  }
  return { start, results };
}

describe('the engine tests page: catalog', () => {
  it('lists every scenario with a progress count, and reflects a verdict', async () => {
    const { app } = await harness();
    const before = await app.request('/api/demo/engine-tests', { headers: headers() });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      items: readonly { id: string; reviewed: boolean; stepCount: number }[];
      progress: { reviewed: number; total: number };
    };
    expect(beforeBody.items).toHaveLength(ENGINE_TESTS.length);
    expect(beforeBody.progress.total).toBe(ENGINE_TESTS.length);
    expect(beforeBody.progress.reviewed).toBe(0);
    for (const item of beforeBody.items) {
      expect(item.stepCount, item.id).toBeGreaterThan(0);
    }

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
  it("walks every step with the server's own pre-filled suggestions, and each step's automatic check passes on the real engine", async () => {
    const { app } = await harness();
    const { start, results } = await walkWithDefaults(app, def.id);
    expect(start.steps.length).toBeGreaterThan(0);
    expect(results).toHaveLength(start.steps.length);
    for (const [index, result] of results.entries()) {
      expect(
        result.autoCheck.passed,
        `step ${String(index + 1)}: ${result.autoCheck.expected} :: ${result.autoCheck.observed}`,
      ).toBe(true);
    }
    expect(start.patientId.length).toBeGreaterThan(0);
  });
});

describe('the guided engine tests: edited input is honored', () => {
  it('a different test name on "Order a test" carries through to the expectation it opens', async () => {
    const { app } = await harness();
    const { start } = await walkWithDefaults(app, 'expectation-has-due-date');
    // Re-run the same scenario on a fresh patient, this time editing the suggested test.
    const second = await app.request('/api/demo/engine-tests/expectation-has-due-date/start', {
      method: 'POST',
      headers: headers(),
    });
    const secondStart = (await second.json()) as StartResponse;
    expect(secondStart.patientId).not.toBe(start.patientId);
    const suggestion = secondStart.steps[0]?.suggestion;
    if (suggestion?.action !== 'record' || suggestion.entry.kind !== 'order') {
      throw new Error('expected the first step to suggest an order');
    }
    const edited: EngineTestStepValue = {
      ...suggestion,
      entry: { ...suggestion.entry, loinc: '2345-7', display: 'Glucose' },
    };
    const response = await app.request('/api/demo/engine-tests/expectation-has-due-date/steps/1', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        day0: secondStart.day0,
        patientId: secondStart.patientId,
        value: edited,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as StepResponse;
    expect(body.autoCheck.passed).toBe(true);
    const labels = (body.expectations as readonly { readonly label: string }[]).map(
      (item) => item.label,
    );
    expect(JSON.stringify(labels)).not.toContain('HbA1c');
    const timelineDetails = (body.timeline as readonly { readonly detail: string }[]).map(
      (entry) => entry.detail,
    );
    expect(timelineDetails.some((detail) => detail.includes('Glucose'))).toBe(true);
  });
});
