import {
  createRuntime,
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseView } from './http/schemas.ts';
import { createApiServer } from './server.ts';
import { createHarness, fixture, type Harness, KEY_A, KEY_B } from './test/harness.ts';

/** HIP-129: least privilege per key, the demo clock is not any clinic's, and safe defaults. */

const INBOX_KEY = 'inbox-key-clinic-a';

describe('scoped API keys and the demo clock', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ env: { DEMO_INBOX_API_KEY: INBOX_KEY } });
  });
  afterEach(async () => {
    await h.close();
  });

  it('lets only demo keys move the shared clock, and then sweeps every clinic', async () => {
    const before = await h.call<{ now: string }>('/api/demo/clock', { key: KEY_B });
    expect(before.status).toBe(200);
    const refused = await h.call<{ error: { code: string } }>('/api/demo/clock/advance', {
      body: { days: 3 },
      key: KEY_B,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('insufficient_scope');
    expect((await h.call<{ now: string }>('/api/demo/clock')).body.now).toBe(before.body.now);

    // Clinic B's overdue order opens a case when the demo operator moves time.
    await h.call('/fhir?sync=true', {
      body: fixture('consultation-diabetology'),
      fhir: true,
      key: KEY_B,
    });
    expect((await h.call('/api/demo/clock/advance', { body: { days: 20 } })).status).toBe(200);
    const casesB = await h.call<{ items: CaseView[] }>('/api/inbox/cases', { key: KEY_B });
    expect(casesB.body.items.length).toBeGreaterThan(0);
  });

  it('gives the inbox key the inbox and the demo, never FHIR ingestion', async () => {
    expect((await h.call('/api/inbox/cases', { key: INBOX_KEY })).status).toBe(200);
    expect(
      (await h.call('/api/demo/clock/advance', { body: { days: 1 }, key: INBOX_KEY })).status,
    ).toBe(200);
    const ingest = await h.call<{ resourceType: string; issue: { code: string }[] }>('/fhir', {
      body: fixture('consultation-diabetology'),
      fhir: true,
      key: INBOX_KEY,
    });
    expect(ingest.status).toBe(403);
    expect(ingest.body.issue[0]?.code).toBe('forbidden');
    expect((await h.call('/fhir/Task', { key: INBOX_KEY })).status).toBe(403);
  });

  it('separates reading the inbox from acting in it', async () => {
    const readOnly = await h.runtime.issueApiKey({
      clinicId: 'clinic-b',
      label: 'tablero',
      scopes: ['inbox:read'],
    });
    expect(readOnly.apiKey).toMatch(/^fue_[A-Za-z0-9_-]{43}$/);
    expect((await h.call('/api/inbox/cases', { key: readOnly.apiKey })).status).toBe(200);
    const act = await h.call('/api/inbox/cases/any/actions', {
      body: { action: 'notify' },
      key: readOnly.apiKey,
    });
    expect(act.status).toBe(403);
    expect((await h.call('/fhir/metadata', { key: '' })).status).toBe(200);
  });

  it('sends security headers and serves the docs UI pinned with Subresource Integrity', async () => {
    const api = await h.call('/openapi.json', { key: '' });
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    expect(api.headers.get('x-frame-options')).toBe('DENY');
    expect(api.headers.get('content-security-policy')).toContain("default-src 'none'");
    const docs = await h.call<string>('/docs', { key: '' });
    expect(docs.text).toMatch(
      /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/api-reference@\d+\.\d+\.\d+\/[^"]+"/,
    );
    expect(docs.text).toMatch(/integrity="sha384-[A-Za-z0-9+/=]{64}"/);
    expect(docs.headers.get('content-security-policy')).toContain(
      'https://cdn.jsdelivr.net/npm/@scalar/api-reference@',
    );
  });
});

describe('rate limits', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      app: { rateLimits: { perKeyPerMinute: 3, failedAuthPerMinute: 2 } },
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers 429 with Retry-After past the per-key limit, per key', async () => {
    const statuses = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await h.call('/api/inbox/stats')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await h.call('/fhir/Task');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.call('/api/inbox/stats', { key: KEY_B })).status).toBe(200);
  });

  it('stops key guessing before it reaches the database', async () => {
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await h.call('/api/inbox/stats', { key: `wrong-${String(index)}` })).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe('production profile', () => {
  it('does not register the demo clinic on a real clock, nor accept the public demo keys', async () => {
    const runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'system',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: DEFAULT_DEMO_API_KEY,
      }),
    );
    expect(await runtime.storage.clinics.listActive()).toEqual([]);
    // A database seeded once by the demo still refuses the published keys.
    await runtime.registerClinic({ id: 'clinic-demo', name: 'Demo', apiKey: DEFAULT_DEMO_API_KEY });
    const { app } = createApiServer(runtime, { port: 0, embeddedWorker: false, corsOrigins: [] });
    const response = await app.request('/api/inbox/cases', {
      headers: { authorization: `Bearer ${DEFAULT_DEMO_API_KEY}` },
    });
    expect(response.status).toBe(401);
    await runtime.close();
  });

  it('refuses public or short demo keys when the demo clinic is forced on a real clock', () => {
    expect(() =>
      loadRuntimeConfig({
        CLOCK: 'system',
        DEMO_CLINIC: 'true',
        DEMO_API_KEY: DEFAULT_DEMO_API_KEY,
      }),
    ).toThrow(/DEMO_API_KEY/);
    expect(() =>
      loadRuntimeConfig({
        CLOCK: 'system',
        DEMO_CLINIC: 'true',
        DEMO_API_KEY: 'a-private-demo-key-of-sufficient-length',
        DEMO_INBOX_API_KEY: DEFAULT_DEMO_INBOX_API_KEY,
      }),
    ).toThrow(/DEMO_INBOX_API_KEY/);
    expect(
      loadRuntimeConfig({
        CLOCK: 'system',
        DEMO_CLINIC: 'true',
        DEMO_API_KEY: 'a-private-demo-key-of-sufficient-length',
      }).demo?.apiKey,
    ).toBe('a-private-demo-key-of-sufficient-length');
    expect(KEY_A).not.toBe(DEFAULT_DEMO_API_KEY);
  });
});
