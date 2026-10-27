import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClinicCommand } from './clinic-cli.ts';
import type { CaseDetail, CaseView } from './http/schemas.ts';
import { createApiServer } from './server.ts';
import { createHarness, fixture, type Harness, KEY_A, KEY_B, STORAGES } from './test/harness.ts';

/** HIP-129 (round 2): failed-auth limiter, demo scopes, key collisions, request ids, audit user. */

const INBOX_KEY = 'inbox-key-clinic-a';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
  };
}

/** Counts the key lookups the API makes (the database load of key guessing). */
function countLookups(runtime: EngineRuntime): { readonly count: () => number } {
  let lookups = 0;
  const original = runtime.authenticate.bind(runtime);
  (runtime as { authenticate: EngineRuntime['authenticate'] }).authenticate = async (key) => {
    lookups += 1;
    return original(key);
  };
  return { count: () => lookups };
}

describe('failed-authentication limit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      app: { rateLimits: { perKeyPerMinute: 100, failedAuthPerMinute: 2 } },
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('never refuses a valid key because others from the same address guessed keys', async () => {
    const guesses = [];
    for (let index = 0; index < 5; index += 1) {
      guesses.push((await h.call('/api/inbox/stats', { key: `wrong-${String(index)}` })).status);
    }
    expect(guesses).toEqual([401, 401, 429, 429, 429]);
    expect((await h.call('/fhir/Task', { key: KEY_B })).status).toBe(200);
    expect((await h.call('/api/inbox/stats')).status).toBe(200);
    expect((await h.call('/api/inbox/stats', { key: 'wrong-again' })).status).toBe(429);
    expect((await h.call('/api/inbox/stats', { key: '' })).status).toBe(429);
    expect((await h.call('/api/inbox/stats', { key: KEY_B })).status).toBe(200);
  });

  it('limits a concurrent wrong-key burst before it reaches the key lookup', async () => {
    const lookups = countLookups(h.runtime);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        h.call('/api/inbox/stats', { key: `burst-${String(index)}` }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(38);
    expect(lookups.count()).toBeLessThanOrEqual(3);
  });
});

describe('request ids', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('echoes a short token and replaces anything else with a generated id', async () => {
    const ok = await h.call('/healthz', { key: '', headers: { 'x-request-id': 'req_abc-123' } });
    expect(ok.headers.get('x-request-id')).toBe('req_abc-123');
    for (const value of ['Paciente Zacarias V-12.345.678', 'B'.repeat(65), 'a.b', 'x;y']) {
      const replaced = await h.call('/healthz', { key: '', headers: { 'x-request-id': value } });
      expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('demo scopes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ env: { DEMO_INBOX_API_KEY: INBOX_KEY } });
  });
  afterEach(async () => {
    await h.close();
  });

  const consultation = {
    patientName: 'Paciente Demo',
    specialty: 'diabetology',
    noteText: 'Paciente con DM2. Plan: control en 3 meses.',
  };

  it('gives the demo inbox key the clock and demo consultations of the demo clinic', async () => {
    const principal = await h.runtime.authenticate(INBOX_KEY);
    expect([...(principal?.scopes ?? [])].sort()).toEqual([
      'demo:clock',
      'demo:ingest',
      'inbox:act',
      'inbox:read',
    ]);
    expect((await h.call('/api/demo/webhooks', { key: INBOX_KEY })).status).toBe(200);
    expect(
      (await h.call('/api/demo/clock/advance', { body: { days: 1 }, key: INBOX_KEY })).status,
    ).toBe(200);
    expect(
      (await h.call('/api/demo/consultations', { body: consultation, key: INBOX_KEY })).status,
    ).toBe(201);
  });

  it('never lets another clinic ingest through the demo, even with the demo scopes', async () => {
    const issued = await h.runtime.issueApiKey({
      clinicId: 'clinic-b',
      label: 'tester',
      scopes: ['demo:clock', 'demo:ingest', 'inbox:read'],
    });
    expect(
      (await h.call('/api/demo/clock/advance', { body: { days: 1 }, key: issued.apiKey })).status,
    ).toBe(200);
    const ingest = await h.call<ErrorBody>('/api/demo/consultations', {
      body: consultation,
      key: issued.apiKey,
    });
    expect(ingest.status).toBe(403);
    expect(ingest.body.error.code).toBe('insufficient_scope');
  });

  it('reads the clock with inbox:read but the webhooks feed only with demo:clock', async () => {
    expect((await h.call('/api/demo/clock', { key: KEY_B })).status).toBe(200);
    expect((await h.call('/api/demo/webhooks', { key: KEY_B })).status).toBe(403);
    expect(
      (await h.call('/api/demo/consultations', { body: consultation, key: KEY_B })).status,
    ).toBe(403);
  });

  it('refuses demo scopes for another clinic in the CLI unless --allow-demo', async () => {
    const refused = await runClinicCommand(h.runtime, [
      '--id',
      'clinic-b',
      '--label',
      'demo',
      '--scopes',
      'demo:clock',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.output).toMatch(/--allow-demo/);
    const allowed = await runClinicCommand(h.runtime, [
      '--id',
      'clinic-b',
      '--label',
      'demo',
      '--scopes',
      'demo:clock',
      '--allow-demo',
    ]);
    expect(allowed.code).toBe(0);
    const demoClinic = await runClinicCommand(h.runtime, [
      '--id',
      'clinic-demo',
      '--label',
      'operator',
      '--scopes',
      'demo:clock,demo:ingest',
    ]);
    expect(demoClinic.code).toBe(0);
    expect((await runClinicCommand(h.runtime, ['--id', 'clinic-b', '--scopes', 'demo'])).code).toBe(
      1,
    );
  });
});

describe('the audit-trail user (X-FollowUp-User)', () => {
  let h: Harness;
  let caseId: string;
  beforeEach(async () => {
    h = await createHarness();
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    await h.call('/api/demo/clock/advance', { body: { days: 92 } });
    const page = await h.call<{ items: CaseView[] }>('/api/inbox/cases');
    caseId = page.body.items[0]?.id ?? '';
  });
  afterEach(async () => {
    await h.close();
  });

  it('decodes a UTF-8 header (no mojibake)', async () => {
    // What Node hands the app for the UTF-8 bytes of "Dr. Médico": one character per byte.
    const latin1View = Buffer.from('Dr. Médico', 'utf8').toString('latin1');
    const snoozed = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'snooze', snoozeDays: 3 },
      headers: { 'x-followup-user': latin1View },
    });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.timeline.at(-1)?.actor).toEqual({ type: 'user', id: 'Dr. Médico' });
  });

  it('keeps a Latin-1 header as it is', async () => {
    const snoozed = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'snooze', snoozeDays: 3 },
      headers: { 'x-followup-user': 'Dra. Peña' },
    });
    expect(snoozed.body.timeline.at(-1)?.actor).toEqual({ type: 'user', id: 'Dra. Peña' });
  });

  it.each([
    ['too long', 'x'.repeat(121)],
    ['a control character', 'Dr.\tMédico'],
    ['an invisible character', 'Dr.­Médico'],
  ])('refuses %s', async (_, value) => {
    const refused = await h.call<ErrorBody>(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'snooze', snoozeDays: 3 },
      headers: { 'x-followup-user': value },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('invalid_request');
  });
});

describe.each(STORAGES)('API key values are unique across clinics (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('refuses a value another clinic holds, even revoked, and leaves that key untouched', async () => {
    await h.runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'shared',
      scopes: ['inbox:read'],
      apiKey: 'shared-key-value',
    });
    await h.runtime.storage.apiKeys.revoke('clinic-demo' as never, 'shared', h.runtime.clock.now());
    await expect(
      h.runtime.issueApiKey({
        clinicId: 'clinic-b',
        label: 'stolen',
        scopes: ['fhir:write', 'inbox:read', 'inbox:act'],
        apiKey: 'shared-key-value',
      }),
    ).rejects.toThrow(/already/);
    expect(await h.runtime.authenticate('shared-key-value')).toBeUndefined();
    // The store itself refuses it too (memory and Postgres behave the same).
    await expect(
      h.runtime.storage.apiKeys.issue({
        keyHash: 'a'.repeat(64),
        clinicId: 'clinic-demo' as never,
        label: 'x',
        scopes: ['inbox:read'],
        createdAt: h.runtime.clock.now(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      h.runtime.storage.apiKeys.issue({
        keyHash: 'a'.repeat(64),
        clinicId: 'clinic-b' as never,
        label: 'x',
        scopes: ['inbox:read'],
        createdAt: h.runtime.clock.now(),
      }),
    ).rejects.toThrow(/already/);
  });

  it("refuses another clinic's integration key as a scoped key, and the reverse", async () => {
    await expect(
      h.runtime.issueApiKey({
        clinicId: 'clinic-b',
        label: 'copy',
        scopes: ['inbox:read'],
        apiKey: KEY_A,
      }),
    ).rejects.toThrow(/already/);
    await h.runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'inbox',
      scopes: ['inbox:read'],
      apiKey: 'collide-key-value',
    });
    await expect(
      h.runtime.registerClinic({ id: 'clinic-z', name: 'Z', apiKey: 'collide-key-value' }),
    ).rejects.toThrow(/already/);
    await expect(
      h.runtime.registerClinic({ id: 'clinic-z', name: 'Z', apiKey: KEY_B }),
    ).rejects.toThrow(/already/);
    expect((await h.runtime.authenticate(KEY_B))?.clinic.id).toBe('clinic-b');
    expect((await h.runtime.authenticate('collide-key-value'))?.clinic.id).toBe('clinic-demo');
  });

  it('re-issuing the same value to the same clinic stays idempotent', async () => {
    for (let index = 0; index < 2; index += 1) {
      await h.runtime.issueApiKey({
        clinicId: 'clinic-b',
        label: 'inbox',
        scopes: ['inbox:read'],
        apiKey: 'same-clinic-key',
      });
      await h.runtime.registerClinic({ id: 'clinic-b', name: 'Clínica B', apiKey: KEY_B });
    }
    expect((await h.runtime.authenticate('same-clinic-key'))?.clinic.id).toBe('clinic-b');
  });
});

describe('the demo clinic on a real clock', () => {
  it('refuses stored short demo keys unless DEMO_CLINIC=true with private 24+ character keys', async () => {
    const runtime = await createRuntime(
      loadRuntimeConfig({ CLOCK: 'system', LOG_LEVEL: 'silent' }),
    );
    // A database that once ran the demo with short custom keys.
    await runtime.registerClinic({ id: 'clinic-demo', name: 'Demo', apiKey: 'mydemo' });
    await runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'demo inbox',
      scopes: ['inbox:read', 'inbox:act'],
      apiKey: 'mydemoinbox',
    });
    const { app } = createApiServer(runtime, { port: 0, embeddedWorker: false, corsOrigins: [] });
    for (const key of ['mydemo', 'mydemoinbox']) {
      const response = await app.request('/api/inbox/clinic', {
        headers: { authorization: `Bearer ${key}` },
      });
      expect({ key, status: response.status }).toEqual({ key, status: 401 });
    }
    await runtime.close();

    const forced = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'system',
        LOG_LEVEL: 'silent',
        DEMO_CLINIC: 'true',
        DEMO_API_KEY: 'a-private-demo-key-of-sufficient-length',
        DEMO_INBOX_API_KEY: 'a-private-inbox-key-of-sufficient-length',
      }),
    );
    expect((await forced.authenticate('a-private-demo-key-of-sufficient-length'))?.clinic.id).toBe(
      'clinic-demo',
    );
    const inbox = await forced.authenticate('a-private-inbox-key-of-sufficient-length');
    expect(inbox?.scopes).toEqual(['inbox:read', 'inbox:act']);
    await forced.close();
  });
});
