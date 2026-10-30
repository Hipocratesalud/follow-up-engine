import { createHmac, randomBytes } from 'node:crypto';
import { createPool } from '@follow-up-engine/adapter-postgres';
import {
  createRuntime,
  type EngineRuntime,
  loadRuntimeConfig,
  Worker,
} from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';
import { STORAGES, TEST_DATABASE_URL } from './test/harness.ts';

const KEY = 'agent-routes-test-key';
const CODE = 'agent-routes-test-code';
const EMAIL = 'agent-tester@example.com';

function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;
let schema: string | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (schema !== undefined) {
    const pool = createPool({ connectionString: TEST_DATABASE_URL ?? '', max: 1 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
    schema = undefined;
  }
});

interface Page {
  readonly conversation: { readonly patientId: string; readonly status: string } | null;
  readonly messages: readonly {
    readonly id: string;
    readonly direction: string;
    readonly text: string;
    readonly offeredSlots?: readonly { readonly id: string }[];
  }[];
  readonly orders: readonly {
    readonly kind: string;
    readonly test?: string;
    readonly stage: string;
  }[];
  readonly steps: readonly {
    readonly kind: string;
    readonly event: string;
    readonly tool?: string;
    readonly outcome: string;
    readonly params?: Record<string, unknown>;
  }[];
  readonly appointments: readonly {
    readonly fhirAppointmentId?: string;
    readonly originCaseId?: string;
  }[];
  readonly findings: readonly { readonly category: string; readonly summary: string }[];
  readonly tasks: readonly { readonly kind: string; readonly summary: { readonly ask: string } }[];
}

async function harness(storage: 'memory' | 'postgres' = 'memory'): Promise<{
  readonly call: (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; body: unknown }>;
  readonly page: () => Promise<Page>;
  readonly worker: Worker;
  readonly runtime: EngineRuntime;
}> {
  schema = storage === 'postgres' ? `follow_up_agent_${randomBytes(5).toString('hex')}` : undefined;
  runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      DEMO_API_KEY: KEY,
      LLM_PROVIDER: 'fake',
      ...(schema === undefined
        ? { DATABASE_URL: '' }
        : { DATABASE_URL: TEST_DATABASE_URL ?? '', DATABASE_SCHEMA: schema }),
    }),
    { poolSize: 3 },
  );
  const { app }: { app: App } = createApiServer(runtime, loadApiConfig({ DEMO_ACCESS_CODE: CODE }));
  const secret = deriveSessionSecret(CODE);
  const headers = {
    authorization: `Bearer ${KEY}`,
    cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EMAIL, secret)}`,
    'content-type': 'application/json',
  };
  return {
    runtime,
    worker: new Worker(runtime),
    page: async () => (await call('/api/demo/agent')).body as Page,
    call,
  };

  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: unknown }> {
    const response = await app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  }
}

describe('the order-to-completion agent (scripted mode)', () => {
  it.each(STORAGES)(
    'plays María’s story on %s: contact, a refusal, a booking, a photo the engine closes',
    async (storage) => {
      const { call, page: read, worker } = await harness(storage);
      const started = await call('/api/demo/agent/story', {
        body: { story: 'maria', mode: 'scripted', language: 'es' },
      });
      expect(started.status).toBe(201);
      const patientId = (started.body as { patientId: string }).patientId;
      await worker.runJobs();

      let page = await read();
      expect(page.conversation?.patientId).toBe(patientId);
      // Only the doctor's orders: the HbA1c and the control visit, not the protocol items.
      expect(page.orders.map((order) => order.test ?? order.kind).sort()).toEqual([
        'HbA1c',
        'visit',
      ]);
      const first = page.messages.at(-1);
      expect(first?.direction).toBe('outbound');
      expect(first?.text).toContain('María');
      expect(first?.text).not.toContain('{first_name}');
      expect(first?.offeredSlots).toHaveLength(1);

      await call(`/api/demo/agent/patients/${patientId}/messages`, {
        body: { text: 'Hola, sí. Ya me hice el examen la semana pasada, pero el martes no puedo.' },
      });
      await worker.runJobs();
      page = await read();
      const options = page.messages.at(-1);
      expect(options?.offeredSlots).toHaveLength(2);

      // "La 2": an explicit choice of an offered slot → booked, and the engine closes the visit.
      await call(`/api/demo/agent/patients/${patientId}/messages`, {
        body: { text: 'La 2 me sirve' },
      });
      await worker.runJobs();
      page = await read();
      expect(page.appointments).toHaveLength(1);
      expect(page.appointments[0]?.fhirAppointmentId).toMatch(/^Appointment\//);
      expect(page.appointments[0]?.originCaseId).toBeDefined();
      expect(
        page.steps.some(
          (step) => step.event === 'expectation_fulfilled' && step.params?.['order'] === 'visit',
        ),
      ).toBe(true);

      await call(`/api/demo/agent/patients/${patientId}/samples`, {
        body: { sample: 'lab_report' },
      });
      await worker.runJobs();
      page = await read();
      expect(page.steps.some((step) => step.kind === 'vision' && step.event === 'photo_read')).toBe(
        true,
      );
      // Only the engine marks the HbA1c order fulfilled, from the FHIR Observation the agent submitted.
      const closed = page.steps.find(
        (step) => step.event === 'expectation_fulfilled' && step.params?.['order'] === 'HbA1c',
      );
      expect(String(closed?.params?.['by'])).toMatch(/^Observation\//);
      expect(page.orders.find((order) => order.test === 'HbA1c')?.stage).toBe('fulfilled');
      // Abnormal result → the clinical reviewer ran; a pre-visit question reached the doctor.
      expect(page.findings.map((finding) => finding.category)).toEqual(
        expect.arrayContaining(['lab_trend', 'pre_visit_question']),
      );
      // Shown first: the HbA1c rise, then the question about it.
      expect(page.findings[0]?.category).toBe('lab_trend');
      expect(page.findings[0]?.summary).toContain('HbA1c');
      expect(page.findings[1]?.summary).toContain('medicación');
      // Never a value to the patient.
      const last = page.messages.at(-1);
      expect(last?.direction).toBe('outbound');
      expect(last?.text).not.toMatch(/8[.,]4/);
      expect(page.conversation?.status).toBe('done');
    },
  );

  it('transcribes the sample voice note and answers it', async () => {
    const { call, page: read, worker } = await harness();
    const { patientId } = (
      await call('/api/demo/agent/story', {
        body: { story: 'maria', mode: 'scripted', language: 'en' },
      })
    ).body as { patientId: string };
    await worker.runJobs();
    await call(`/api/demo/agent/patients/${patientId}/samples`, { body: { sample: 'voice_note' } });
    await worker.runJobs();
    const page = await read();
    const voice = page.steps.find((step) => step.event === 'voice_transcribed');
    expect(String(voice?.params?.['transcript'])).toContain('Tuesday');
    expect(page.messages.at(-1)?.offeredSlots).toHaveLength(2);
  });

  it('runs the ladder on the clinic clock, caps messages and creates staff tasks', async () => {
    const { call, page: read, worker } = await harness();
    await call('/api/demo/agent/story', {
      body: { story: 'maria', mode: 'scripted', language: 'en' },
    });
    await worker.runJobs();
    for (const days of [4, 5, 5, 7]) {
      expect((await call('/api/demo/agent/clock', { body: { days } })).status).toBe(200);
      await worker.runJobs();
    }
    const page = await read();
    const outbound = page.messages.filter((message) => message.direction === 'outbound');
    // Day 0, day 4 and day 9: three proactive messages, never more than two in seven days.
    expect(outbound).toHaveLength(3);
    expect(page.tasks.some((task) => task.kind === 'call_patient')).toBe(true);
    expect(page.tasks.some((task) => task.kind === 'doctor_notice')).toBe(true);
    expect(page.conversation?.status).toBe('unreachable');
  });

  it('stops messaging on an undelivered message and asks reception for the phone', async () => {
    const { call, page: read, worker } = await harness();
    const { patientId } = (
      await call('/api/demo/agent/story', {
        body: { story: 'maria', mode: 'scripted', language: 'en' },
      })
    ).body as { patientId: string };
    await worker.runJobs();
    const page = await read();
    const sent = page.messages.at(-1);
    await call(`/api/demo/agent/messages/${sent?.id ?? ''}/status`, {
      body: { status: 'undelivered' },
    });
    await call('/api/demo/agent/clock', { body: { days: 4 } });
    await worker.runJobs();
    const after = await read();
    expect(after.messages.filter((message) => message.direction === 'outbound')).toHaveLength(1);
    expect(after.tasks.map((task) => task.kind)).toContain('update_phone');
    await call(`/api/demo/agent/patients/${patientId}/phone-fixed`, { method: 'POST' });
    await worker.runJobs();
    const fixed = await read();
    expect(fixed.messages.filter((message) => message.direction === 'outbound')).toHaveLength(2);
  });

  it('records an opt-out by code and never writes again', async () => {
    const { call, page: read, worker } = await harness();
    const { patientId } = (
      await call('/api/demo/agent/story', {
        body: { story: 'maria', mode: 'scripted', language: 'es' },
      })
    ).body as { patientId: string };
    await worker.runJobs();
    await call(`/api/demo/agent/patients/${patientId}/messages`, {
      body: { text: 'Por favor no me escriban más' },
    });
    await worker.runJobs();
    await call('/api/demo/agent/clock', { body: { days: 10 } });
    await worker.runJobs();
    const page = await read();
    expect(page.conversation?.status).toBe('opted_out');
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(1);
  });

  it('follows the urgent ladder when an abnormal result asks for a visit', async () => {
    const { call, page: read, worker } = await harness();
    await call('/api/demo/agent/story', {
      body: { story: 'maria_urgent', mode: 'scripted', language: 'en' },
    });
    await worker.runJobs();
    let page = await read();
    expect(page.orders.some((order) => order.kind === 'visit')).toBe(true);
    expect(page.messages.at(-1)?.text).toContain('this week');
    for (let day = 0; day < 3; day += 1) {
      await call('/api/demo/agent/clock', { body: { days: 1 } });
      await worker.runJobs();
    }
    page = await read();
    // Hour 0 and day 1: two messages; day 2 a high-priority call; day 3 the doctor directly.
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(2);
    expect(page.tasks.map((task) => task.kind).sort()).toEqual(['call_patient', 'doctor_notice']);
    await call('/api/demo/agent/clock', { body: { days: 4 } });
    await worker.runJobs();
    page = await read();
    expect(page.conversation?.status).toBe('unreachable');
  });

  it('refuses the live mode without a real model, and every route without an evaluator', async () => {
    const { call } = await harness();
    const live = await call('/api/demo/agent/story', {
      body: { story: 'maria', mode: 'live', language: 'en' },
    });
    expect(live.status).toBe(422);
    if (runtime === undefined) throw new Error('no runtime');
    const anonymous = await createApiServer(runtime, loadApiConfig({})).app.request(
      '/api/demo/agent',
      { headers: { authorization: `Bearer ${KEY}` } },
    );
    expect(anonymous.status).toBe(403);
  });
});
