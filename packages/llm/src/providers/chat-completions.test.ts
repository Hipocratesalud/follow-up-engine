import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LlmProviderError, LlmSchemaError, LlmTimeoutError } from '../errors.ts';
import { parseRetryAfter, readUsage, type FetchLike } from './chat-completions.ts';
import { createMetaProvider, META_API_BASE_URL } from './meta.ts';
import {
  BASETEN_BASE_URL,
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  createBasetenProvider,
  createOpenAiCompatibleProvider,
} from './openai-compatible.ts';

const Output = z.object({ answer: z.string(), score: z.number().nullable() });
const output = { name: 'test_output', schema: Output };
const messages = [
  { role: 'system' as const, content: 'You extract.' },
  { role: 'user' as const, content: 'Note text' },
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function completion(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'muse-spark-1.3',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 1000 },
      completion_tokens_details: { reasoning_tokens: 120 },
    },
    ...extra,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetch(...responses: (Response | Error)[]): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const queue = [...responses];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}

describe('Meta provider', () => {
  it('posts an OpenAI-style chat completion with strict json_schema and Bearer auth', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(completion('{"answer":"ok","score":0.5}')));
    const provider = createMetaProvider({ apiKey: 'test-key', fetch, promptCacheKey: 'p@1' });

    const result = await provider.complete({
      model: 'muse-spark-1.3',
      messages,
      output,
      temperature: 0,
      maxOutputTokens: 2000,
    });

    expect(result.output).toEqual({ answer: 'ok', score: 0.5 });
    const [call] = calls;
    expect(call?.url).toBe(`${META_API_BASE_URL}/chat/completions`);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(headers['content-type']).toBe('application/json');
    expect(call?.init.method).toBe('POST');
    expect(call?.body).toMatchObject({
      model: 'muse-spark-1.3',
      messages,
      temperature: 0,
      max_completion_tokens: 2000,
      reasoning_effort: 'low',
      prompt_cache_key: 'p@1',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'test_output', strict: true, schema: { type: 'object' } },
      },
    });
    expect(call?.body).not.toHaveProperty('max_tokens');
  });

  it('reports usage including cached and reasoning tokens', async () => {
    const { fetch } = mockFetch(jsonResponse(completion('{"answer":"ok","score":null}')));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const result = await provider.complete({ model: 'muse-spark-1.3', messages, output });
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 1000,
      reasoningTokens: 120,
    });
    expect(result.provider).toBe('meta');
    expect(result.model).toBe('muse-spark-1.3');
  });

  it('sends strict: false when the schema has optional keys', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(completion('{"a":"x"}')));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    await provider.complete({
      model: 'muse-spark-1.3',
      messages,
      output: { name: 'loose', schema: z.object({ a: z.string(), b: z.string().optional() }) },
    });
    expect(calls[0]?.body).toMatchObject({ response_format: { json_schema: { strict: false } } });
  });

  it('rejects an empty API key at construction', () => {
    expect(() => createMetaProvider({ apiKey: ' ' })).toThrow(/META_API_KEY/);
  });

  it.each([
    [429, true, 'rate_limit_error'],
    [500, true, 'server_error'],
    [503, true, 'service_overloaded'],
    [400, false, 'invalid_request_error'],
    [401, false, 'authentication_error'],
    [402, false, 'insufficient_quota'],
  ])('maps HTTP %i to a provider error (retryable: %s)', async (status, retryable, code) => {
    const { fetch } = mockFetch(
      jsonResponse(
        { error: { message: `boom ${String(status)}`, type: code, code: null } },
        { status, headers: { 'retry-after': '2' } },
      ),
    );
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const error = await provider
      .complete({ model: 'muse-spark-1.3', messages, output })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      provider: 'meta',
      status,
      retryable,
      code,
      retryAfterMs: 2000,
      message: `HTTP ${String(status)}: boom ${String(status)}`,
    });
  });

  it('keeps the vendor error code from the real 402 billing body', async () => {
    // Body observed from api.meta.ai on 2026-10-26 with a key whose team has no billing set up.
    const body = {
      error: {
        code: 'billing_not_configured',
        message: 'Billing verification failed. Billing Issue.',
        param: null,
        type: 'billing_error',
      },
    };
    const { fetch } = mockFetch(jsonResponse(body, { status: 402 }));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    await expect(
      provider.complete({ model: 'muse-spark-1.3', messages, output }),
    ).rejects.toMatchObject({
      status: 402,
      code: 'billing_not_configured',
      retryable: false,
    });
  });

  it('refuses Contributor-mode models unless explicitly allowed', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(completion('{"answer":"ok","score":null}')));
    const strictProvider = createMetaProvider({ apiKey: 'k', fetch });
    await expect(
      strictProvider.complete({ model: 'muse-spark-1.3-contributor', messages, output }),
    ).rejects.toThrow(/Contributor-mode/);
    expect(calls).toHaveLength(0);
    const evalProvider = createMetaProvider({ apiKey: 'k', fetch, allowContributorMode: true });
    await expect(
      evalProvider.complete({ model: 'muse-spark-1.3-contributor', messages, output }),
    ).resolves.toMatchObject({ output: { answer: 'ok' } });
  });

  it('maps a network failure to a retryable error', async () => {
    const { fetch } = mockFetch(new TypeError('fetch failed'));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    await expect(provider.complete({ model: 'm', messages, output })).rejects.toMatchObject({
      name: 'LlmProviderError',
      retryable: true,
    });
  });

  it('maps its own timeout to LlmTimeoutError', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const error = await provider
      .complete({ model: 'm', messages, output, timeoutMs: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('throws a repairable schema error with the raw reply when validation fails', async () => {
    const { fetch } = mockFetch(jsonResponse(completion('{"answer":42}')));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const error = await provider
      .complete({ model: 'm', messages, output })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmSchemaError);
    const schemaError = error as LlmSchemaError;
    expect(schemaError.repairable).toBe(true);
    expect(schemaError.rawOutput).toBe('{"answer":42}');
    expect(schemaError.issues).toContain('answer');
    expect(schemaError.usage.inputTokens).toBe(1200);
  });

  it('flags invalid JSON as repairable', async () => {
    const { fetch } = mockFetch(jsonResponse(completion('not json at all')));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    await expect(provider.complete({ model: 'm', messages, output })).rejects.toMatchObject({
      repairable: true,
      issues: expect.stringContaining('not valid JSON') as unknown,
    });
  });

  it('treats a truncated reply and a refusal as not repairable', async () => {
    const truncated = {
      choices: [
        { message: { role: 'assistant', content: '{"answer":"o' }, finish_reason: 'length' },
      ],
    };
    const refusal = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            refusal: 'No puedo: Rosalinda Quintero, VIH+',
          },
          finish_reason: 'stop',
        },
      ],
    };
    const { fetch } = mockFetch(jsonResponse(truncated), jsonResponse(refusal));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    await expect(provider.complete({ model: 'm', messages, output })).rejects.toMatchObject({
      repairable: false,
      issues: expect.stringContaining('truncated') as unknown,
    });
    const refused: unknown = await provider
      .complete({ model: 'm', messages, output })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ repairable: false, issues: 'model refused' });
    // The refusal text is model output that can quote the note: never in the message.
    expect(String(refused)).not.toMatch(/Rosalinda|VIH/);
  });

  it('accepts replies wrapped in a Markdown fence', async () => {
    const { fetch } = mockFetch(
      jsonResponse(completion('```json\n{"answer":"ok","score":1}\n```')),
    );
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const result = await provider.complete({ model: 'm', messages, output });
    expect(result.output.answer).toBe('ok');
  });
});

describe('Baseten provider (Muse Spark Open)', () => {
  it('forces a single tool call, since Muse Spark Open has no response_format on Baseten', async () => {
    const reply = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'test_output', arguments: '{"answer":"tool","score":null}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const { fetch, calls } = mockFetch(jsonResponse(reply));
    const provider = createBasetenProvider({ apiKey: 'bt-key', fetch });

    const result = await provider.complete({
      model: BASETEN_MUSE_SPARK_OPEN_MODEL,
      messages,
      output,
      maxOutputTokens: 500,
    });

    expect(result.output).toEqual({ answer: 'tool', score: null });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const [call] = calls;
    expect(call?.url).toBe(`${BASETEN_BASE_URL}/chat/completions`);
    expect((call?.init.headers as Record<string, string>)['authorization']).toBe('Bearer bt-key');
    expect(call?.body).toMatchObject({
      model: 'meta-models/muse-spark-open',
      max_tokens: 500,
      tool_choice: { type: 'function', function: { name: 'test_output' } },
      tools: [
        { type: 'function', function: { name: 'test_output', parameters: { type: 'object' } } },
      ],
    });
    expect(call?.body).not.toHaveProperty('response_format');
    const sent = call?.body['messages'] as { role: string; content: string }[];
    expect(sent[0]?.content).toContain('calling the function "test_output"');
  });
});

describe('OpenAI-compatible provider', () => {
  it('puts the schema in the system prompt in json_object mode', async () => {
    const { fetch, calls } = mockFetch(jsonResponse(completion('{"answer":"x","score":2}')));
    const provider = createOpenAiCompatibleProvider({
      name: 'together',
      baseUrl: 'https://example.test/v1/',
      apiKey: 'k',
      outputMode: 'json_object',
      fetch,
    });
    const result = await provider.complete({ model: 'some/model', messages, output });
    expect(result.provider).toBe('together');
    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ response_format: { type: 'json_object' } });
    const sent = calls[0]?.body['messages'] as { role: string; content: string }[];
    expect(sent).toHaveLength(2);
    expect(sent[0]?.content).toContain('"answer"');
  });

  it('adds a system message in prompt mode when there is none', async () => {
    const { fetch, calls } = mockFetch(
      jsonResponse(completion('Sure: {"answer":"x","score":null}')),
    );
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      outputMode: 'prompt',
      fetch,
    });
    const result = await provider.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      output,
    });
    expect(result.output.answer).toBe('x');
    const sent = calls[0]?.body['messages'] as { role: string }[];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user']);
    expect(calls[0]?.body).not.toHaveProperty('response_format');
  });
});

describe('helpers', () => {
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.UTC(2026, 9, 21, 7, 28, 0))).toBe(
      5000,
    );
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('reads missing usage as zero', () => {
    expect(readUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(readUsage({ usage: { prompt_tokens: -1, completion_tokens: 'x' } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('measures latency with the injected clock', async () => {
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(350);
    const { fetch } = mockFetch(jsonResponse(completion('{"answer":"ok","score":null}')));
    const provider = createMetaProvider({ apiKey: 'k', fetch, now });
    const result = await provider.complete({ model: 'm', messages, output });
    expect(result.latencyMs).toBe(250);
  });
});
