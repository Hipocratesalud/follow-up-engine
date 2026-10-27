import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve, type ServerType } from '@hono/node-server';
import { createPool } from '@follow-up-engine/adapter-postgres';
import { modelOutputFromExpected } from '@follow-up-engine/llm';
import {
  createRuntime,
  createWebhookSinkApp,
  type EngineRuntime,
  loadRuntimeConfig,
  WEBHOOK_SINK_PATH,
  WebhookSink,
} from '@follow-up-engine/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseDetail, CaseView } from '../src/http/schemas.ts';
import { type ApiServer, createApiServer } from '../src/server.ts';

/*
 * End to end, as a host sees it: the API and its embedded worker against a
 * real Postgres (own throwaway schema), webhooks over real HTTP to a sink that
 * verifies every signature. The consultation is the example Bundle of
 * docs/integration.md, read from the document itself so the two cannot drift.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const title =
  DATABASE_URL === undefined || DATABASE_URL === ''
    ? 'API end to end [skipped: DATABASE_URL is not set; run `docker compose up -d postgres` and export DATABASE_URL=postgres://postgres:postgres@localhost:54329/follow_up_engine]'
    : 'API end to end (Postgres, worker, signed webhooks)';

const KEY_A = `e2e-a-${randomBytes(8).toString('hex')}`;
const KEY_B = `e2e-b-${randomBytes(8).toString('hex')}`;
const SECRET = `whsec-${randomBytes(12).toString('hex')}`;
const PATIENT = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01';

function exampleBundle(): { text: string; json: unknown } {
  const doc = readFileSync(new URL('../../../docs/integration.md', import.meta.url), 'utf8');
  const marker = doc.indexOf('<!-- e2e:consultation-bundle -->');
  const block = /```json\n([\s\S]*?)\n```/.exec(doc.slice(marker));
  if (marker === -1 || block?.[1] === undefined) {
    throw new Error('docs/integration.md lost its example consultation Bundle');
  }
  return { text: block[1], json: JSON.parse(block[1]) };
}

function noteOf(bundle: unknown): string {
  const entries = (bundle as { entry: { resource: Record<string, unknown> }[] }).entry;
  const doc = entries.find((entry) => entry.resource['resourceType'] === 'DocumentReference');
  const content = doc?.resource['content'] as { attachment: { data: string } }[];
  return Buffer.from(content[0]?.attachment.data ?? '', 'base64').toString('utf8');
}

const RESULT_BUNDLE = readFileSync(
  new URL('../../../packages/fhir/fixtures/bundles/result-hba1c.json', import.meta.url),
  'utf8',
);
const INVALID_BUNDLE = readFileSync(
  new URL('../../../packages/fhir/fixtures/bundles/invalid-consultation.json', import.meta.url),
  'utf8',
);

async function eventually<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(title, () => {
  const schema = `follow_up_e2e_${randomBytes(5).toString('hex')}`;
  const sink = new WebhookSink({ secret: SECRET, toleranceSeconds: 300 });
  /** Every webhook as it went over the wire, to try replaying one. */
  const wire: { headers: Record<string, string>; body: string }[] = [];
  let sinkServer: ServerType;
  let sinkBase = '';
  let runtime: EngineRuntime;
  let server: ApiServer;
  let base = '';
  const example = exampleBundle();

  // Callers name the shape of the JSON body they assert on.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async function call<T>(
    path: string,
    init: { method?: string; body?: string | object; key?: string | null; fhir?: boolean } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (init.key !== null) {
      headers['authorization'] = `Bearer ${init.key ?? KEY_A}`;
    }
    if (init.body !== undefined) {
      headers['content-type'] = init.fhir === true ? 'application/fhir+json' : 'application/json';
    }
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text === '' ? undefined : JSON.parse(text)) as T,
      headers: response.headers,
    };
  }

  beforeAll(async () => {
    const sinkPort = await new Promise<number>((resolve) => {
      const sinkApp = createWebhookSinkApp(sink);
      const capture = async (request: Request): Promise<Response> => {
        if (request.method === 'POST') {
          wire.push({
            headers: Object.fromEntries(request.headers),
            body: await request.clone().text(),
          });
        }
        return sinkApp.fetch(request);
      };
      sinkServer = serve({ fetch: capture, port: 0 }, (info) => {
        resolve(info.port);
      });
    });
    sinkBase = `http://127.0.0.1:${String(sinkPort)}`;
    runtime = await createRuntime(
      loadRuntimeConfig({
        DATABASE_URL,
        DATABASE_SCHEMA: schema,
        CLOCK: 'fake',
        LLM_PROVIDER: 'fake',
        LOG_LEVEL: 'warn',
        DEMO_API_KEY: KEY_A,
        WEBHOOK_URL: `http://127.0.0.1:${String(sinkPort)}${WEBHOOK_SINK_PATH}`,
        WEBHOOK_SINK_URL: `http://127.0.0.1:${String(sinkPort)}`,
        WEBHOOK_SECRET: SECRET,
        WORKER_POLL_MS: '200',
        OUTBOX_POLL_MS: '200',
      }),
      {
        service: 'e2e',
        poolSize: 5,
        // What a perfect reading of the example note returns (fake LLM provider).
        noteFixtures: [
          {
            text: noteOf(example.json),
            output: modelOutputFromExpected({
              hasPlan: true,
              conditions: [{ icd10: 'E11', evidenceQuote: 'DM2 no controlada' }],
              medications: [
                { text: 'metformina 850 mg c/12h', evidenceQuote: 'metformina 850 mg c/12h' },
              ],
              planItems: [
                {
                  kind: 'follow_up_visit',
                  dueInDays: 90,
                  evidenceQuote: 'Control en 3 meses con resultados',
                },
              ],
            }),
          },
        ],
      },
    );
    await runtime.registerClinic({ id: 'clinic-e2e-b', name: 'Clínica B', apiKey: KEY_B });
    server = createApiServer(runtime, { port: 0, embeddedWorker: true, corsOrigins: [] });
    base = `http://127.0.0.1:${String(await server.listen(0))}`;
  });

  afterAll(async () => {
    await server.close();
    sinkServer.close();
    const pool = createPool({ connectionString: DATABASE_URL ?? '', max: 1 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('rejects requests without a key and with an unknown key', async () => {
    const missing = await call<{ error: { code: string } }>('/api/inbox/cases', { key: null });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('unauthorized');
    const unknown = await call<{ resourceType: string }>('/fhir/Task', { key: 'not-a-key' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.resourceType).toBe('OperationOutcome');
  });

  it('answers an invalid Bundle with a 400 OperationOutcome', async () => {
    const response = await call<{ resourceType: string; issue: { severity: string }[] }>('/fhir', {
      body: INVALID_BUNDLE,
      fhir: true,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/application\/fhir\+json/);
    expect(response.body.resourceType).toBe('OperationOutcome');
    expect(
      response.body.issue.filter((issue) => issue.severity === 'error').length,
    ).toBeGreaterThan(0);
  });

  it('ingests the integration guide consultation and exposes its expectations as Tasks', async () => {
    const ingested = await call<{ type: string }>('/fhir?sync=true', {
      body: example.text,
      fhir: true,
    });
    expect(ingested.status).toBe(200);
    expect(ingested.body.type).toBe('transaction-response');

    const tasks = await call<{
      entry: { resource: { code: { coding: { code: string }[] }; status: string } }[];
    }>(`/fhir/Task?patient=${PATIENT}&status=requested`);
    const rules = tasks.body.entry.map((entry) => entry.resource.code.coding[0]?.code);
    expect(rules.filter((rule) => rule === 'lab_order_result_pending')).toHaveLength(2);
    expect(rules).toContain('doctor_plan_followup');
  });

  let pendingResultsCase = '';

  it('opens a case when the lab results are overdue and tells the host with a signed webhook', async () => {
    const advanced = await call<{ now: string }>('/api/demo/clock/advance', { body: { days: 16 } });
    expect(advanced.body.now).toBe('2026-01-21T12:00:00.000Z');

    const page = await call<{ items: CaseView[] }>('/api/inbox/cases');
    expect(page.body.items).toHaveLength(1);
    const [opened] = page.body.items;
    expect(opened?.reasons.map((reason) => reason.ruleId)).toEqual([
      'lab_order_result_pending',
      'lab_order_result_pending',
    ]);
    expect(opened?.reasons.map((reason) => reason.source.display).sort()).toEqual([
      'HbA1c',
      'Perfil lipídico',
    ]);
    expect(opened?.assignee).toBe('Dr. Luis Sintético');
    pendingResultsCase = opened?.id ?? '';

    const delivery = await eventually(async () => {
      const webhooks = await call<{
        items: { type: string; signatureValid: boolean; payload: { data: { caseId: string } } }[];
      }>('/api/demo/webhooks?limit=50');
      return webhooks.body.items.find(
        (item) => item.type === 'case.opened' && item.payload.data.caseId === pendingResultsCase,
      );
    }, 'the case.opened webhook');
    expect(delivery.signatureValid).toBe(true);
    expect(sink.list({ clinicId: 'clinic-demo' }).every((item) => item.signatureValid)).toBe(true);
  });

  it('signs timestamp and delivery id too: a captured webhook cannot be replayed', async () => {
    const original = wire.find((item) => item.headers['x-followup-event'] === 'case.opened');
    expect(original).toBeDefined();
    const replay = (headers: Record<string, string>) =>
      fetch(`${sinkBase}${WEBHOOK_SINK_PATH}`, {
        method: 'POST',
        headers,
        body: original?.body ?? '',
      });
    const fresh = String(Math.floor(Date.now() / 1000));
    const replayed = await replay({
      ...original?.headers,
      'x-followup-timestamp': fresh,
      'x-followup-delivery': 'evt-REPLAYED',
    });
    expect(replayed.status).toBe(401);
    // The genuine redelivery still verifies (and is flagged as a duplicate).
    const again = await replay({ ...original?.headers });
    expect(again.status).toBe(204);
    expect(sink.list({ limit: 1 })[0]?.duplicate).toBe(true);
  });

  it('lets an inbox-scoped key read and act, never ingest', async () => {
    const inbox = await runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'e2e inbox',
      scopes: ['inbox:read', 'inbox:act'],
    });
    expect((await call('/api/inbox/cases', { key: inbox.apiKey })).status).toBe(200);
    const ingest = await call<{ resourceType: string }>('/fhir', {
      body: RESULT_BUNDLE,
      fhir: true,
      key: inbox.apiKey,
    });
    expect(ingest.status).toBe(403);
    expect(ingest.body.resourceType).toBe('OperationOutcome');
  });

  it('fulfills the HbA1c order when the result arrives asynchronously', async () => {
    const accepted = await call<{ type: string }>('/fhir', { body: RESULT_BUNDLE, fhir: true });
    expect(accepted.status).toBe(202);
    expect(accepted.body.type).toBe('batch-response');
    expect(accepted.headers.get('x-followup-job')).toBeTruthy();

    const completed = await eventually(async () => {
      const tasks = await call<{
        entry?: { resource: { status: string; focus?: { reference?: string } } }[];
      }>(`/fhir/Task?patient=${PATIENT}&code=lab_order_result_pending&status=completed`);
      return tasks.body.entry?.[0];
    }, 'the HbA1c expectation to be fulfilled by the worker');
    expect(completed.resource.focus?.reference).toBe(
      'ServiceRequest/5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e05',
    );
  });

  let planCase = '';

  it('opens the doctor-plan case with the verbatim quote and the surrounding note', async () => {
    await call('/api/demo/clock/advance', { body: { days: 76 } });
    const page = await call<{ items: CaseView[] }>('/api/inbox/cases');
    const found = page.body.items.find((item) =>
      item.reasons.some((reason) => reason.layer === 'doctor_plan'),
    );
    const reason = found?.reasons.find((item) => item.layer === 'doctor_plan');
    expect(reason?.ruleId).toBe('doctor_plan_followup');
    expect(reason?.evidence?.quote).toBe('Control en 3 meses con resultados');
    expect(reason?.label).not.toMatch(/\d/);
    planCase = found?.id ?? '';

    const detail = await call<CaseDetail>(`/api/inbox/cases/${planCase}`);
    expect(detail.body.reasons[0]?.evidence?.noteExcerpt).toContain(
      'Plan: continuar metformina 850 mg c/12h',
    );
    expect(detail.body.timeline[0]).toMatchObject({ type: 'opened', actor: { type: 'rule' } });
  });

  it('lets the team ask for patient contact and record feedback, all in the timeline', async () => {
    const contacted = await call<CaseDetail>(`/api/inbox/cases/${planCase}/actions`, {
      body: { action: 'notify' },
    });
    expect(contacted.status).toBe(200);
    expect(contacted.body.timeline.at(-1)).toMatchObject({
      type: 'patient_contact_requested',
      actor: { type: 'user' },
    });

    const request = await eventually(async () => {
      const webhooks = await call<{
        items: {
          type: string;
          signatureValid: boolean;
          payload: { data: Record<string, unknown> };
        }[];
      }>('/api/demo/webhooks?limit=100');
      return webhooks.body.items.find(
        (item) =>
          item.type === 'patient_contact.requested' && item.payload.data['caseId'] === planCase,
      );
    }, 'the patient_contact.requested webhook');
    expect(request.signatureValid).toBe(true);
    expect(Object.keys(request.payload.data).sort()).toEqual([
      'caseId',
      'dueBy',
      'patientId',
      'purpose',
      'task',
    ]);

    const missingReason = await call(`/api/inbox/cases/${planCase}/feedback`, {
      body: { useful: false },
    });
    expect(missingReason.status).toBe(422);
    const feedback = await call<CaseDetail>(`/api/inbox/cases/${planCase}/feedback`, {
      body: { useful: false, reason: 'already_handled', comment: 'Ya tenía cita' },
    });
    expect(feedback.body.feedback).toEqual({
      useful: false,
      reason: 'already_handled',
      comment: 'Ya tenía cita',
    });
    expect(feedback.body.timeline.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'opened',
        'notified',
        'patient_contact_requested',
        'feedback_recorded',
      ]),
    );

    const resolved = await call<CaseDetail>(`/api/inbox/cases/${planCase}/actions`, {
      body: { action: 'resolve' },
    });
    expect(resolved.body.status).toBe('resolved');
    const again = await call<{ error: { code: string } }>(`/api/inbox/cases/${planCase}/actions`, {
      body: { action: 'dismiss' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_transition');
  });

  it('keeps clinics apart: clinic B sees nothing of clinic A', async () => {
    const list = await call<{ items: CaseView[] }>('/api/inbox/cases?view=all', { key: KEY_B });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    expect((await call(`/api/inbox/cases/${pendingResultsCase}`, { key: KEY_B })).status).toBe(404);
    expect((await call(`/fhir/Task/${pendingResultsCase}`, { key: KEY_B })).status).toBe(404);
    const tasks = await call<{ total: number }>(`/fhir/Task?patient=${PATIENT}`, { key: KEY_B });
    expect(tasks.body.total).toBe(0);
    expect((await call(`/api/inbox/patients/${PATIENT}`, { key: KEY_B })).status).toBe(404);
    const webhooks = await call<{ items: unknown[] }>('/api/demo/webhooks', { key: KEY_B });
    expect(webhooks.body.items).toEqual([]);
  });
});
