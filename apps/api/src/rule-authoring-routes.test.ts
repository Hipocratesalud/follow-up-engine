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
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';

/**
 * The rule-authoring routes (docs/agent/rule-authoring.md) in an
 * evaluator's lab sandbox: sample patients, a scripted draft with its
 * dry run and trace, never live until "enable" (which records the
 * evaluator), and another evaluator's lab never sees it.
 */

const KEY = 'rule-authoring-test-key';
const CODE = 'rule-authoring-test-code';

function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function harness(): Promise<App> {
  runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
  );
  return createApiServer(runtime, loadApiConfig({ DEMO_ACCESS_CODE: CODE })).app;
}

function headers(email: string): Record<string, string> {
  return {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(email, deriveSessionSecret(CODE))}`,
    'content-type': 'application/json',
  };
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

async function call(app: App, email: string, path: string, body?: unknown): Promise<Reply> {
  const response = await app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(email),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

interface RuleView {
  readonly ruleId: string;
  readonly status: string;
  readonly live: boolean;
  readonly validatedBy?: string;
  readonly baseline?: { readonly id: string };
  readonly provenance: {
    readonly dryRun: {
      readonly patientsMatched: number;
      readonly expectations: { overdue: number };
    };
    readonly trace: readonly { readonly tool: string }[];
    readonly firstValidationPassed: boolean;
  };
}

describe('rule-authoring routes in the evaluator lab', () => {
  it('drafts from a sentence, dry-runs on the sample patients, and goes live only when enabled', async () => {
    const app = await harness();
    const email = 'dr.rules@example.com';
    expect((await call(app, email, '/api/demo/lab/rules/samples', {})).status).toBe(201);
    const page = await call(app, email, '/api/demo/lab/rules');
    expect(page.body).toMatchObject({ items: [], patients: 9, liveAvailable: false });

    const drafted = await call(app, email, '/api/demo/lab/rules/drafts', {
      request: 'Para mis pacientes con hipotiroidismo en levotiroxina, TSH cada 6 meses',
      mode: 'scripted',
    });
    expect(drafted.status).toBe(201);
    const draftedBody = drafted.body as { status: string; rule: RuleView };
    expect(draftedBody.status).toBe('drafted');
    const rule = draftedBody.rule;
    expect(rule).toMatchObject({
      ruleId: 'clinic_hypothyroidism_tsh_6m',
      status: 'draft',
      live: false,
    });
    expect(rule.baseline?.id).toBe('hypothyroidism');
    expect(rule.provenance.firstValidationPassed).toBe(true);
    // Lucía (overdue) and Mario (on time); Elena is not on levothyroxine.
    expect(rule.provenance.dryRun.patientsMatched).toBe(2);
    expect(rule.provenance.dryRun.expectations.overdue).toBe(1);
    expect(rule.provenance.trace.at(-1)?.tool).toBe('submit_draft');

    const live = await call(app, email, '/api/demo/lab/rules/drafts', {
      request: 'After a positive FIT, colonoscopy within 60 days',
      mode: 'live',
    });
    expect(live.status).toBe(422);

    const enabled = await call(
      app,
      email,
      '/api/demo/lab/rules/clinic_hypothyroidism_tsh_6m/enable',
      {},
    );
    expect(enabled.status).toBe(200);
    expect((enabled.body as { rule: RuleView }).rule).toMatchObject({
      status: 'enabled',
      live: true,
      validatedBy: email,
    });
    const again = await call(
      app,
      email,
      '/api/demo/lab/rules/clinic_hypothyroidism_tsh_6m/enable',
      {},
    );
    expect(again.status).toBe(409);

    const catalog = await runtime?.engine.catalog(labClinicId(email));
    expect(
      catalog?.protocols.some((protocol) => protocol.id === 'clinic_hypothyroidism_tsh_6m'),
    ).toBe(true);

    // Another evaluator's sandbox never sees it.
    const other = 'dr.other@example.com';
    const theirs = await call(app, other, '/api/demo/lab/rules');
    expect(theirs.body).toMatchObject({ items: [] });
    expect(
      (await call(app, other, '/api/demo/lab/rules/clinic_hypothyroidism_tsh_6m/discard', {}))
        .status,
    ).toBe(404);
    const otherCatalog = await runtime?.engine.catalog(labClinicId(other));
    expect(otherCatalog?.protocols.some((protocol) => protocol.id.startsWith('clinic_'))).toBe(
      false,
    );
  });

  it('answers a request it cannot draft with the reason, and stores nothing', async () => {
    const app = await harness();
    const email = 'dr.abstain@example.com';
    const result = await call(app, email, '/api/demo/lab/rules/drafts', {
      request: 'Write to every patient that their results are fine',
      mode: 'scripted',
    });
    expect(result.body).toMatchObject({ status: 'failed', reason: 'abstained' });
    expect((await call(app, email, '/api/demo/lab/rules')).body).toMatchObject({ items: [] });
  });
});
