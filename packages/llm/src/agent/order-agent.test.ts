import {
  clinicId,
  ORDER_AGENT_TOOLS,
  type OrderAgentModelCall,
  type OrderAgentToolbox,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import type { FetchLike } from '../providers/chat-completions.ts';
import { createFakeProvider, type FakeResponder } from '../providers/fake.ts';
import { createMetaProvider } from '../providers/meta.ts';
import {
  createFakeTranscriber,
  createMetaTranscriber,
  sha256Hex,
} from '../providers/transcription.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { createPatientMediaReader, labPhotoMessages, LAB_PHOTO_OUTPUT_NAME } from './media.ts';
import { createOrderAgentModel } from './order-agent.ts';
import { outboundSafetyTerms } from './outbound-terms.ts';
import { ORDER_AGENT_ACTION_NAME, ORDER_AGENT_SCRIPTED_TASK, ORDER_AGENT_TASK } from './prompt.ts';

const CLINIC = clinicId('clinic-agent');

function gatewayWith(
  respond: FakeResponder,
  extra: Partial<Parameters<typeof createLlmGateway>[0]> = {},
) {
  return createLlmGateway({
    providers: { fake: createFakeProvider({ respond }) },
    tasks: {
      [ORDER_AGENT_TASK]: { route: [{ provider: 'fake', model: 'fake-order-agent' }] },
      [ORDER_AGENT_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: 'fake-order-agent' }] },
      lab_photo_reading_scripted: { route: [{ provider: 'fake', model: 'fake-vision' }] },
    },
    usageLog: new InMemoryLlmUsageLog(),
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

function recordingToolbox(): OrderAgentToolbox & {
  readonly executed: string[];
  readonly rejected: string[];
} {
  const executed: string[] = [];
  const rejected: string[] = [];
  return {
    definitions: ORDER_AGENT_TOOLS,
    executed,
    rejected,
    execute(name) {
      executed.push(name);
      return Promise.resolve({ ok: true, result: { done: name } });
    },
    reject(name, error) {
      rejected.push(`${name}:${error}`);
      return Promise.resolve();
    },
  };
}

describe('the order agent loop', () => {
  it('runs one tool per step, validates arguments and ends on end_turn', async () => {
    const script = [
      { thought: 'orders', tool: 'list_open_orders', arguments: '{}' },
      { thought: 'bad', tool: 'get_available_slots', arguments: '{"orderId": 3}' },
      { thought: 'made up', tool: 'book_everything', arguments: '{}' },
      { thought: 'done', tool: 'end_turn', arguments: '{"summary":"ok"}' },
    ];
    let index = 0;
    const gateway = gatewayWith((request) => {
      if (request.output.name !== ORDER_AGENT_ACTION_NAME) return undefined;
      return script[index++];
    });
    const toolbox = recordingToolbox();
    const calls: OrderAgentModelCall[] = [];
    const result = await createOrderAgentModel({ gateway }).runTurn(CLINIC, {
      mode: 'scripted',
      context: { trigger: 'take_ownership' },
      toolbox,
      maxSteps: 8,
      redactTerms: [],
      onModelCall: (call) => {
        calls.push(call);
        return Promise.resolve();
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(toolbox.executed).toEqual(['list_open_orders', 'end_turn']);
    expect(toolbox.rejected).toEqual([
      'get_available_slots:invalid_arguments',
      'book_everything:unknown_tool',
    ]);
    expect(calls.map((call) => call.tool)).toEqual(script.map((step) => step.tool));
  });

  it('ends the turn when the model answers in prose after acting', async () => {
    let index = 0;
    const gateway = gatewayWith((request) => {
      if (request.output.name !== ORDER_AGENT_ACTION_NAME) return undefined;
      index += 1;
      return index === 1
        ? { thought: 'orders', tool: 'list_open_orders', arguments: '{}' }
        : 'All done!';
    });
    const toolbox = recordingToolbox();
    const result = await createOrderAgentModel({ gateway }).runTurn(CLINIC, {
      mode: 'scripted',
      context: {},
      toolbox,
      maxSteps: 8,
      redactTerms: [],
      onModelCall: () => Promise.resolve(),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(toolbox.executed).toEqual(['list_open_orders', 'end_turn']);
  });

  it('reminds a model that answers in prose once, and goes on when it then calls a tool', async () => {
    const replies: unknown[] = [
      { thought: 'orders', tool: 'list_open_orders', arguments: '{}' },
      // Prose twice: the call and the gateway's repair attempt both fail.
      'Hola, te escribo de la clínica para agendar tu control.',
      'Hola, te escribo de la clínica para agendar tu control.',
      { thought: 'send', tool: 'send_message', arguments: '{"text":"Hola {first_name}"}' },
      { thought: 'done', tool: 'end_turn', arguments: '{"summary":"ok"}' },
    ];
    let index = 0;
    let reminder = '';
    const gateway = gatewayWith((request) => {
      if (request.output.name !== ORDER_AGENT_ACTION_NAME) return undefined;
      const last = request.messages.at(-1)?.content ?? '';
      if (last.includes('tool="protocol"')) reminder = last;
      return replies[index++];
    });
    const toolbox = recordingToolbox();
    const result = await createOrderAgentModel({ gateway }).runTurn(CLINIC, {
      mode: 'scripted',
      context: {},
      toolbox,
      maxSteps: 8,
      redactTerms: [],
      onModelCall: () => Promise.resolve(),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(toolbox.executed).toEqual(['list_open_orders', 'send_message', 'end_turn']);
    expect(toolbox.rejected).toEqual(['prose:prose_reminded']);
    expect(reminder).toContain('no_tool_call');
  });

  it('masks the patient’s name in everything the model reads', async () => {
    let seen = '';
    const gateway = gatewayWith((request) => {
      if (request.output.name !== ORDER_AGENT_ACTION_NAME) return undefined;
      seen = request.messages.map((message) => message.content).join('\n');
      return { thought: 'done', tool: 'end_turn', arguments: '{"summary":"x"}' };
    });
    await createOrderAgentModel({ gateway }).runTurn(CLINIC, {
      mode: 'scripted',
      context: { latestPatientMessage: { text: 'Soy María Fernanda Rojas' } },
      toolbox: recordingToolbox(),
      maxSteps: 2,
      redactTerms: ['María Fernanda Rojas', 'María', 'Rojas'],
      onModelCall: () => Promise.resolve(),
    });
    expect(seen).not.toContain('Rojas');
    expect(seen).toContain('Soy');
  });
});

describe('the patient’s media', () => {
  it('sends a photo as an image_url part next to the text', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = (_url, init) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    isLabReport: true,
                    reportDate: '2025-12-29',
                    patientName: null,
                    tests: [
                      { name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 200 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const gateway = createLlmGateway({
      providers: { meta: createMetaProvider({ apiKey: 'test', fetch }) },
      tasks: { lab_photo_reading: { route: [{ provider: 'meta', model: 'muse-spark-1.3' }] } },
      usageLog: new InMemoryLlmUsageLog(),
    });
    const read = await createPatientMediaReader({ gateway }).readLabPhoto(CLINIC, {
      mode: 'live',
      image: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    expect(read.reading.tests[0]).toEqual({
      name: 'HbA1c',
      value: 8.4,
      unit: '%',
      referenceLow: 4,
      referenceHigh: 5.6,
    });
    const messages = bodies[0]?.['messages'] as { content: unknown }[];
    const parts = messages[1]?.content as { type: string; image_url?: { url: string } }[];
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(parts[1]?.image_url?.url).toBe('data:image/jpeg;base64,AQID');
    expect(labPhotoMessages('image/png', new Uint8Array([0]))[1]?.images).toHaveLength(1);
    expect(LAB_PHOTO_OUTPUT_NAME).toBe('lab_photo_reading');
  });

  it('transcribes on the Meta ASR endpoint with a multipart request', async () => {
    let url = '';
    let form: FormData | undefined;
    const fetch: FetchLike = (target, init) => {
      url = target;
      form = init.body as FormData;
      return Promise.resolve(
        new Response(JSON.stringify({ transcript: ' Hola ', audioDurationMs: 3000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const transcriber = createMetaTranscriber({ apiKey: 'test', fetch });
    const result = await transcriber.transcribe({
      model: 'muse-voice-transcribe-1.0',
      audio: new Uint8Array([1, 2]),
      contentType: 'audio/wav',
    });
    expect(url).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect(result).toMatchObject({ transcript: 'Hola', durationMs: 3000 });
    const request = form?.get('request');
    expect(request).toBeInstanceOf(Blob);
    expect(JSON.parse(await (request as Blob).text())).toEqual({
      model: 'muse-voice-transcribe-1.0',
      audioEncoding: 'WAV',
      mode: 'PUSH_TO_TALK',
    });
  });

  it('accounts a transcription on the gateway and refuses it past the budget', async () => {
    const audio = new Uint8Array(32_000 * 60);
    const usageLog = new InMemoryLlmUsageLog();
    const gateway = createLlmGateway({
      providers: {},
      tasks: {},
      transcribers: { fake: createFakeTranscriber({ [sha256Hex(audio)]: 'hello' }) },
      transcriptionTasks: { voice: { provider: 'fake', model: 'fake-transcriber' } },
      usageLog,
      monthlyBudgetUsd: () => 0,
    });
    await expect(
      gateway.transcribe(CLINIC, { task: 'voice', audio, contentType: 'audio/wav' }),
    ).rejects.toThrow('budget');
    const open = createLlmGateway({
      providers: {},
      tasks: {},
      transcribers: { fake: createFakeTranscriber({ [sha256Hex(audio)]: 'hello' }) },
      transcriptionTasks: { voice: { provider: 'fake', model: 'fake-transcriber' } },
      usageLog,
    });
    const heard = await open.transcribe(CLINIC, { task: 'voice', audio, contentType: 'audio/wav' });
    expect(heard.transcript).toBe('hello');
    expect(usageLog.records.at(-1)?.task).toBe('voice');
  });
});

describe('the outbound term list', () => {
  it('holds condition names in both languages but not everyday words', () => {
    const { conditionTerms } = outboundSafetyTerms();
    expect(conditionTerms).toEqual(expect.arrayContaining(['diabetes', 'dm2', 'hipertension']));
    expect(conditionTerms).not.toContain('mi');
    expect(conditionTerms).not.toContain('cold');
  });
});
