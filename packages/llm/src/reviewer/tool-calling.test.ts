import { REVIEW_TOOL_DEFINITIONS } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { LlmSchemaError } from '../errors.ts';
import type { FetchLike } from '../providers/chat-completions.ts';
import { createMetaProvider } from '../providers/meta.ts';
import { createOpenAiCompatibleProvider } from '../providers/openai-compatible.ts';
import { REVIEWER_ACTION_NAME, ReviewerActionSchema } from './prompt.ts';

/**
 * The reviewer on a real endpoint: native tool calling over the OpenAI
 * Chat Completions protocol (Meta Model API, Baseten), and the structured
 * fallback for endpoints without it. Mocked fetch, no network.
 */

interface Captured {
  readonly body: Record<string, unknown>;
}

function mockFetch(reply: unknown): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (_url, init) => {
    calls.push({ body: JSON.parse(init.body as string) as Record<string, unknown> });
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

const tools = REVIEW_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
}));
const request = {
  model: 'muse-spark-1.3',
  messages: [
    { role: 'system' as const, content: 'You review.' },
    { role: 'user' as const, content: '<review_input>{}</review_input>' },
  ],
  output: { name: REVIEWER_ACTION_NAME, schema: ReviewerActionSchema },
  tools,
};

function toolCallReply(name: string, args: string, content: string | null = null): unknown {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 60 },
  };
}

describe('native tool calling (Meta Model API)', () => {
  it('sends every tool with its JSON Schema and requires a call', async () => {
    const { fetch, calls } = mockFetch(toolCallReply('get_lab_trend', '{"test":"creatinine"}'));
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const result = await provider.complete(request);
    const body = calls[0]?.body ?? {};
    expect(body['tool_choice']).toBe('required');
    expect(body['parallel_tool_calls']).toBe(false);
    expect(body['response_format']).toBeUndefined();
    const sent = body['tools'] as {
      function: { name: string; parameters: Record<string, unknown> };
    }[];
    expect(sent.map((tool) => tool.function.name)).toEqual([
      'get_lab_trend',
      'get_notes',
      'get_medications',
      'get_open_follow_ups',
      'check_interaction',
      'submit_findings',
    ]);
    expect(sent[0]?.function.parameters).toMatchObject({
      type: 'object',
      properties: { test: { type: 'string' } },
      required: ['test'],
      additionalProperties: false,
    });
    // The call comes back as the agent's action object.
    expect(result.output).toEqual({
      thought: '',
      tool: 'get_lab_trend',
      arguments: '{"test":"creatinine"}',
    });
    expect(result.usage).toMatchObject({ inputTokens: 900, outputTokens: 60 });
  });

  it('a text reply without a tool call is a repairable schema error', async () => {
    const { fetch } = mockFetch({
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'I think...' } },
      ],
    });
    const provider = createMetaProvider({ apiKey: 'k', fetch });
    const error: unknown = await provider.complete(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmSchemaError);
    expect((error as LlmSchemaError).repairable).toBe(true);
  });
});

describe('structured fallback (endpoints without tool calling)', () => {
  it('ignores the tools and asks for the same action object as structured output', async () => {
    const { fetch, calls } = mockFetch({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({ thought: 'ok', tool: 'get_medications', arguments: '{}' }),
          },
        },
      ],
    });
    const provider = createOpenAiCompatibleProvider({
      name: 'other',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      toolCalling: 'structured',
    });
    const withFetch = createOpenAiCompatibleProvider({
      name: 'other',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      toolCalling: 'structured',
      fetch,
    });
    expect(provider.name).toBe('other');
    const result = await withFetch.complete(request);
    const body = calls[0]?.body ?? {};
    expect(body['tools']).toBeUndefined();
    expect(body['response_format']).toMatchObject({
      type: 'json_schema',
      json_schema: { name: REVIEWER_ACTION_NAME, strict: true },
    });
    expect(result.output).toEqual({ thought: 'ok', tool: 'get_medications', arguments: '{}' });
  });
});
