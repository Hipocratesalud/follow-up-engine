import { createHmac, randomBytes } from 'node:crypto';
import { createPool } from '@follow-up-engine/adapter-postgres';
import {
  createRuntime,
  type EngineRuntime,
  loadRuntimeConfig,
  readSample,
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
    readonly orderId: string;
    readonly kind: string;
    readonly test?: string;
    readonly stage: string;
    readonly urgent: boolean;
    readonly doctorConfirmation?: { readonly by: string; readonly at: string };
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
  readonly tasks: readonly {
    readonly kind: string;
    readonly status: string;
    readonly summary: { readonly ask: string; readonly orders: readonly string[] };
  }[];
}

/** Muse Spark's HTTP API, stubbed (the live path's real gateway requests go through it). */
type LlmFetch = (input: string, init: RequestInit) => Promise<Response>;

async function harness(
  storage: 'memory' | 'postgres' = 'memory',
  llmFetch?: LlmFetch,
): Promise<{
  readonly call: (
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string>; form?: FormData },
  ) => Promise<{ status: number; body: unknown }>;
  readonly page: () => Promise<Page>;
  /** The patient sends a file (multipart), as the simulated phone's upload does. */
  readonly upload: (path: string, file: File) => Promise<{ status: number; body: unknown }>;
  readonly worker: Worker;
  readonly runtime: EngineRuntime;
}> {
  schema = storage === 'postgres' ? `follow_up_agent_${randomBytes(5).toString('hex')}` : undefined;
  runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      DEMO_API_KEY: KEY,
      ...(llmFetch === undefined
        ? { LLM_PROVIDER: 'fake' }
        : { LLM_PROVIDER: 'meta', META_API_KEY: 'test-key' }),
      ...(schema === undefined
        ? { DATABASE_URL: '' }
        : { DATABASE_URL: TEST_DATABASE_URL ?? '', DATABASE_SCHEMA: schema }),
    }),
    { poolSize: 3, ...(llmFetch === undefined ? {} : { llmFetch }) },
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
    upload,
  };

  async function upload(path: string, file: File): Promise<{ status: number; body: unknown }> {
    const form = new FormData();
    form.set('file', file, file.name);
    // The browser sets the multipart boundary: no JSON content type here.
    const multipart = { authorization: headers.authorization, cookie: headers.cookie };
    const response = await app.request(path, { method: 'POST', headers: multipart, body: form });
    return { status: response.status, body: await response.json() };
  }

  async function call(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      form?: FormData;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    if (init.form !== undefined) {
      // Multipart: the runtime sets the boundary; only the auth headers are ours.
      const auth = { authorization: headers.authorization, cookie: headers.cookie };
      const response = await app.request(path, { method: 'POST', headers: auth, body: init.form });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
    }
    const response = await app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...headers, ...init.headers },
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
      // PRD V1-D: an offer carries two or three slots computed by code.
      expect(first?.offeredSlots).toHaveLength(2);

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
      // In the reader's language (both are stored): English by default, Spanish on request.
      expect(page.findings[1]?.summary).toContain('medication');
      const spanish = (await call('/api/demo/agent', { headers: { 'accept-language': 'es' } }))
        .body as Page;
      expect(spanish.findings[1]?.summary).toContain('medicación');
      // Never a value to the patient.
      const last = page.messages.at(-1);
      expect(last?.direction).toBe('outbound');
      expect(last?.text).not.toMatch(/8[.,]4/);
      expect(page.conversation?.status).toBe('done');
    },
  );

  it.each(STORAGES)(
    'reads a PDF lab report María sends on %s: same reading, matched, submitted, and the engine closes the HbA1c order',
    async (storage) => {
      const { call, page: read, upload, worker } = await harness(storage);
      const started = await call('/api/demo/agent/story', {
        body: { story: 'maria', mode: 'scripted', language: 'es' },
      });
      const patientId = (started.body as { patientId: string }).patientId;
      await worker.runJobs();
      expect((await read()).orders.find((order) => order.test === 'HbA1c')?.stage).not.toBe(
        'fulfilled',
      );

      const sent = await upload(
        `/api/demo/agent/patients/${patientId}/messages`,
        new File([readSample('labReportPdf')], 'informe.pdf', { type: 'application/pdf' }),
      );
      expect(sent.status).toBe(201);
      expect((sent.body as { kind: string }).kind).toBe('document');
      await worker.runJobs();
      const page = await read();
      // The PDF's text went through the lab-result reading (no OCR of an image).
      const reading = page.steps.find((step) => step.event === 'document_read');
      expect(reading?.kind).toBe('vision');
      expect(String(reading?.params?.['tests'])).toContain('8.4');
      // The same tools as a photo: match, then the FHIR Observation.
      const tools = page.steps.filter((step) => step.kind === 'tool').map((step) => step.tool);
      expect(tools).toEqual(
        expect.arrayContaining(['match_result_to_order', 'submit_fhir_result']),
      );
      // Only the engine marks the order fulfilled, from the Observation the agent submitted.
      const closed = page.steps.find(
        (step) => step.event === 'expectation_fulfilled' && step.params?.['order'] === 'HbA1c',
      );
      expect(String(closed?.params?.['by'])).toMatch(/^Observation\//);
      expect(page.orders.find((order) => order.test === 'HbA1c')?.stage).toBe('fulfilled');
      // Thanked for the report, never told a value.
      const last = page.messages.at(-1);
      expect(last?.direction).toBe('outbound');
      expect(last?.text).toContain('informe');
      expect(last?.text).not.toMatch(/8[.,]4/);
    },
  );

  it('masks María’s name in her PDF report’s text before the live reading (the gateway request never carries it)', async () => {
    const reports: string[] = [];
    const { call, upload, worker } = await harness('memory', async (_url, init) => {
      const body = init.body as string;
      if (!body.includes('<report>')) {
        // Nothing else is stubbed: the note reading and the agent's turns fail, the reading does not.
        return Promise.resolve(new Response('{"error":"not stubbed"}', { status: 400 }));
      }
      reports.push(body);
      const reading = {
        isLabReport: true,
        reportDate: '2025-12-29',
        patientName: '[REDACTADO]',
        tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(reading) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 400, completion_tokens: 150 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const started = await call('/api/demo/agent/story', {
      body: { story: 'maria', mode: 'live', language: 'es' },
    });
    expect(started.status).toBe(201);
    await worker.runJobs();
    const patientId = (started.body as { patientId: string }).patientId;
    const sent = await upload(
      `/api/demo/agent/patients/${patientId}/messages`,
      new File([readSample('labReportPdf')], 'informe.pdf', { type: 'application/pdf' }),
    );
    expect(sent.status).toBe(201);
    await worker.runJobs();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('HbA1c');
    expect(reports[0]).toContain('[REDACTADO]');
    for (const part of ['María', 'Maria', 'Fernanda', 'Rojas']) {
      expect(reports[0]).not.toContain(part);
    }
  });

  it('refuses a file the simulated phone does not take (not WAV, an image or a PDF)', async () => {
    const { call, upload, worker } = await harness();
    const started = await call('/api/demo/agent/story', {
      body: { story: 'maria', mode: 'scripted', language: 'en' },
    });
    await worker.runJobs();
    const patientId = (started.body as { patientId: string }).patientId;
    const refused = await upload(
      `/api/demo/agent/patients/${patientId}/messages`,
      new File(['hello'], 'note.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    expect(refused.status).toBe(422);
  });

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

  it.each(STORAGES)(
    'shows the story started last after a restart on %s, and logs every control of the agent page',
    async (storage) => {
      const { call, page: read, worker, runtime: engine } = await harness(storage);
      // Restarts on a lab clock that has not moved: every story starts at the same time.
      const started: string[] = [];
      for (let restart = 0; restart < 4; restart++) {
        const response = await call('/api/demo/agent/story', {
          body: { story: 'maria', mode: 'scripted', language: 'en' },
        });
        started.push((response.body as { patientId: string }).patientId);
        await worker.runJobs();
        expect((await read()).conversation?.patientId).toBe(started.at(-1));
      }
      const patientId = started.at(-1) ?? '';
      // Every control of the agent page, once.
      const ok = (response: { status: number }): void => {
        expect(response.status).toBeLessThan(300);
      };
      ok(
        await call('/api/evaluator/events', {
          body: { action: 'page_viewed', page: 'agent' },
        }),
      );
      ok(
        await call('/api/evaluator/events', {
          body: { action: 'agent_model_switched', mode: 'live' },
        }),
      );
      ok(
        await call('/api/evaluator/events', {
          body: { action: 'agent_language_switched', language: 'es' },
        }),
      );
      ok(
        await call(`/api/demo/agent/patients/${patientId}/messages`, {
          body: { text: 'Hi, yes. I already had the test last week.', source: 'suggested' },
        }),
      );
      ok(
        await call(`/api/demo/agent/patients/${patientId}/messages`, {
          body: { text: 'Can I go on Friday?' },
        }),
      );
      ok(
        await call(`/api/demo/agent/patients/${patientId}/samples`, {
          body: { sample: 'lab_report' },
        }),
      );
      const form = new FormData();
      form.set('file', new File([readSample('voiceEn')], 'note.wav', { type: 'audio/wav' }));
      ok(await call(`/api/demo/agent/patients/${patientId}/messages`, { form }));
      await worker.runJobs();
      const page = await read();
      const outbound = page.messages.find((message) => message.direction === 'outbound');
      ok(
        await call(`/api/demo/agent/messages/${outbound?.id ?? ''}/status`, {
          body: { status: 'read' },
        }),
      );
      ok(await call(`/api/demo/agent/patients/${patientId}/phone-fixed`, { method: 'POST' }));
      ok(await call('/api/demo/agent/clock', { body: { days: 1 } }));
      // Not a tracked page: refused, nothing logged.
      expect(
        (await call('/api/evaluator/events', { body: { action: 'page_viewed', page: 'admin' } }))
          .status,
      ).toBe(422);

      const sent = page.messages.filter((message) => message.direction === 'inbound');
      const events = (
        await engine.storage.evaluatorEvents.list({ evaluatorEmail: EMAIL, limit: 100 })
      ).items;
      const of = (action: string) => events.filter((event) => event.action === action);
      expect(of('agent_story_started').map((event) => event.payload?.['restart'])).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(of('page_viewed').map((event) => event.payload)).toEqual([{ page: 'agent' }]);
      expect(of('agent_model_switched').map((event) => event.payload)).toEqual([{ mode: 'live' }]);
      expect(of('agent_language_switched').map((event) => event.payload)).toEqual([
        { language: 'es' },
      ]);
      expect(of('agent_reply_suggested').map((event) => [event.entityId, event.payload])).toEqual([
        [sent[0]?.id, { kind: 'text', source: 'suggested' }],
      ]);
      expect(of('agent_message_typed').map((event) => [event.entityId, event.payload])).toEqual([
        [sent[1]?.id, { kind: 'text', source: 'typed' }],
      ]);
      expect(of('agent_sample_sent').map((event) => event.payload)).toEqual([
        { kind: 'image', source: 'sample', sample: 'lab_report' },
      ]);
      expect(of('agent_media_uploaded').map((event) => event.payload)).toEqual([
        { kind: 'voice', source: 'upload' },
      ]);
      expect(
        of('agent_delivery_status_set').map((event) => [event.entityId, event.payload]),
      ).toEqual([[outbound?.id, { status: 'read' }]]);
      expect(of('agent_phone_fixed').map((event) => event.patientId)).toEqual([patientId]);
      expect(of('agent_clock_jumped').map((event) => event.payload?.['days'])).toEqual([1]);
      // Every event names the patient it was about (the story's Maria).
      for (const action of ['agent_reply_suggested', 'agent_message_typed', 'agent_sample_sent']) {
        expect(of(action).every((event) => event.patientId === patientId)).toBe(true);
      }
    },
  );

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
    const notice = page.tasks.find((task) => task.kind === 'doctor_notice');
    expect(notice?.summary.ask).toBe('patient_unreachable');
    expect(notice?.summary.orders.length).toBe(2);
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

  it('asks the doctor first when an abnormal result asks for a visit, then follows the urgent ladder', async () => {
    const { call, page: read, worker } = await harness();
    const { patientId } = (
      await call('/api/demo/agent/story', {
        body: { story: 'maria_urgent', mode: 'scripted', language: 'en' },
      })
    ).body as { patientId: string };
    await worker.runJobs();
    let page = await read();
    // The lab's result reached the doctor before the agent wrote: the rise and the question.
    expect(page.findings[0]?.category).toBe('lab_trend');
    expect(page.findings[1]?.category).toBe('pre_visit_question');
    // The visit the engine asked for (abnormal_result_followup) waits for the doctor:
    // the agent only pursues what the doctor wrote (the routine control and the test).
    const awaiting = page.orders.filter((order) => order.stage === 'awaiting_doctor');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.urgent).toBe(true);
    const confirmTask = page.tasks.find((task) => task.summary.ask === 'confirm_followup');
    expect(confirmTask?.kind).toBe('doctor_notice');
    const before = page.messages.filter((message) => message.direction === 'outbound');
    expect(before).toHaveLength(1);
    expect(before[0]?.text).not.toContain('this week');
    expect(
      page.steps.filter((step) => step.event === 'doctor_confirmation_requested'),
    ).toHaveLength(1);
    // Days pass without the doctor: still nothing urgent goes out.
    await call('/api/demo/agent/clock', { body: { days: 1 } });
    await worker.runJobs();
    page = await read();
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(1);
    expect(page.orders.find((order) => order.stage === 'awaiting_doctor')).toBeDefined();

    // The doctor confirms: recorded with who and when, and the urgent track starts.
    const order = awaiting[0]?.orderId ?? '';
    const confirmed = await call(`/api/demo/agent/patients/${patientId}/orders/${order}/confirm`, {
      method: 'POST',
    });
    expect(confirmed.status).toBe(204);
    await worker.runJobs();
    page = await read();
    const confirmedOrder = page.orders.find((item) => item.orderId === order);
    expect(confirmedOrder?.doctorConfirmation?.by).toBe(EMAIL);
    expect(confirmedOrder?.doctorConfirmation?.at).toMatch(/^\d{4}-/);
    expect(
      page.steps.find((step) => step.event === 'order_confirmed_by_doctor')?.params?.['by'],
    ).toBe(EMAIL);
    expect(page.tasks.find((task) => task.summary.ask === 'confirm_followup')?.status).toBe('done');
    expect(page.messages.at(-1)?.text).toContain('this week');
    // Confirming twice is refused.
    expect(
      (
        await call(`/api/demo/agent/patients/${patientId}/orders/${order}/confirm`, {
          method: 'POST',
        })
      ).status,
    ).toBe(409);

    for (let day = 0; day < 3; day += 1) {
      await call('/api/demo/agent/clock', { body: { days: 1 } });
      await worker.runJobs();
    }
    page = await read();
    // The cap is per patient: the routine first contact and the urgent hour-0 message
    // fill it, so the urgent day-1 message is skipped; day 2 a high-priority call, day 3 the doctor.
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(2);
    expect(
      page.steps
        .filter((step) => step.event === 'rung_skipped')
        .map((step) => [step.params?.['rung'], step.params?.['block']]),
    ).toEqual([['urgent:1d', 'cap_reached']]);
    expect(
      page.tasks
        .filter((task) => task.summary.ask !== 'confirm_followup')
        .map((task) => task.kind)
        .sort(),
    ).toEqual(['call_patient', 'doctor_notice']);
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
