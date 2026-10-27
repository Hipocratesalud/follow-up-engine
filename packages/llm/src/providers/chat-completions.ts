import type { LlmMessage } from '@follow-up-engine/core';
import { LlmProviderError, LlmSchemaError, LlmTimeoutError } from '../errors.ts';
import { isStrictCompatible, toJsonSchema, type JsonSchema } from '../json-schema.ts';
import type { DetailedUsage, ProviderCompletion, ProviderRequest } from '../usage.ts';
import { parseStructuredOutput } from './structured-output.ts';

/**
 * How a provider asks the model for structured output.
 *
 * - `json_schema`: `response_format: { type: 'json_schema' }` (Meta Model
 *   API, OpenAI and most OpenAI-compatible servers).
 * - `tool`: a single forced function call whose parameters are the schema.
 *   For endpoints that support tool calling but not `response_format`
 *   (Muse Spark Open on Baseten, as of 2026-10-26).
 * - `json_object`: legacy JSON mode plus the schema in the system prompt.
 * - `prompt`: schema in the system prompt only, reply parsed leniently.
 *
 * Every mode validates the reply with zod, so a weaker mode costs repair
 * attempts, never invalid data.
 */
export const STRUCTURED_OUTPUT_MODES = ['json_schema', 'tool', 'json_object', 'prompt'] as const;
export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number];

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** An LLM provider that also accepts an abort signal and reports detailed usage. */
export interface StructuredLlmProvider {
  readonly name: string;
  complete<TOutput>(request: ProviderRequest<TOutput>): Promise<ProviderCompletion<TOutput>>;
}

export interface ChatCompletionsProviderOptions {
  /** Provider name used for pricing, logs and errors, for example `meta` or `baseten`. */
  readonly name: string;
  /** Base URL that ends before `/chat/completions`, for example `https://api.meta.ai/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly outputMode: StructuredOutputMode;
  /**
   * Send `strict: true` with `json_schema` when the schema allows it (closed
   * objects, every key required). Defaults to true.
   */
  readonly strict?: boolean;
  /** `max_completion_tokens` (current OpenAI and Meta) or the older `max_tokens`. */
  readonly maxTokensParam?: 'max_completion_tokens' | 'max_tokens';
  /**
   * How an agent step with `request.tools` is sent. `native` (default): the
   * tools go as OpenAI `tools` with `tool_choice: 'required'` and the call
   * the model makes is returned as `{ thought, tool, arguments }`.
   * `structured`: the tools are ignored here (the agent's prompt lists
   * them) and the same object comes back through `outputMode`. Use
   * `structured` for an endpoint without tool calling.
   */
  readonly toolCalling?: 'native' | 'structured';
  /**
   * `tool_choice` of a native agent step. `required` (default) forces a
   * call; `auto` lets the model answer in text, which comes back as a
   * repairable "no tool call" error and is re-asked by the gateway. The
   * Meta Model API accepts only `auto` (400 otherwise, 2026-10-27).
   */
  readonly toolChoice?: 'required' | 'auto';
  /** Extra body fields merged into every request, for example `{ reasoning_effort: 'low' }`. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  /** Monotonic clock in milliseconds, for latency. Defaults to `performance.now`. */
  readonly now?: () => number;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

/**
 * A provider for any endpoint that speaks the OpenAI Chat Completions
 * protocol (`POST {baseUrl}/chat/completions`). The Meta Model API and
 * Baseten Model APIs both do; `meta.ts` and `openai-compatible.ts` only set
 * defaults on top of this.
 */
export function createChatCompletionsProvider(
  options: ChatCompletionsProviderOptions,
): StructuredLlmProvider {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => performance.now());
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const strict = options.strict ?? true;
  const maxTokensParam = options.maxTokensParam ?? 'max_completion_tokens';
  const toolCalling = options.toolCalling ?? 'native';
  const { name } = options;

  async function complete<TOutput>(
    request: ProviderRequest<TOutput>,
  ): Promise<ProviderCompletion<TOutput>> {
    const schema = toJsonSchema(request.output.schema);
    const nativeTools =
      toolCalling === 'native' && request.tools !== undefined && request.tools.length > 0
        ? request.tools
        : undefined;
    const body: Record<string, unknown> = {
      ...options.extraBody,
      model: request.model,
      ...(nativeTools === undefined
        ? {
            messages: buildMessages(
              request.messages,
              options.outputMode,
              request.output.name,
              schema,
            ),
            ...formatFields(options.outputMode, request.output.name, schema, strict),
          }
        : {
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            tools: nativeTools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: toJsonSchema(tool.parameters),
              },
            })),
            tool_choice: options.toolChoice ?? 'required',
            parallel_tool_calls: false,
          }),
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.maxOutputTokens !== undefined) body[maxTokensParam] = request.maxOutputTokens;

    const signals: AbortSignal[] = [];
    if (request.signal) signals.push(request.signal);
    if (request.timeoutMs !== undefined) signals.push(AbortSignal.timeout(request.timeoutMs));
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    const started = now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...options.headers,
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw transportError(name, cause, signal, request.timeoutMs);
    }

    if (!response.ok) throw await httpError(name, response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new LlmProviderError(name, 'Response body is not JSON', {
        status: response.status,
        retryable: true,
        cause,
      });
    }
    const latencyMs = Math.round(now() - started);
    const usage = readUsage(payload);
    const raw =
      nativeTools === undefined
        ? readReply(name, request.model, payload, options.outputMode, usage)
        : readToolCall(name, request.model, payload, usage);
    const output = parseStructuredOutput(name, request.model, raw, request.output.schema, usage);
    return { output, usage, latencyMs, provider: name, model: request.model, rawOutput: raw };
  }

  return { name, complete };
}

function schemaInstruction(outputName: string, schema: JsonSchema): string {
  return [
    `Reply with a single JSON object named "${outputName}" that conforms to this JSON Schema.`,
    'Output only the JSON object: no prose, no Markdown fences.',
    JSON.stringify(schema),
  ].join('\n');
}

function buildMessages(
  messages: readonly LlmMessage[],
  mode: StructuredOutputMode,
  outputName: string,
  schema: JsonSchema,
): ChatMessage[] {
  const out: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  let extra: string | undefined;
  switch (mode) {
    case 'json_schema':
      return out;
    case 'tool':
      extra = `Return your answer by calling the function "${outputName}" exactly once.`;
      break;
    case 'json_object':
    case 'prompt':
      extra = schemaInstruction(outputName, schema);
      break;
  }
  const systemIndex = out.findIndex((m) => m.role === 'system');
  const system = systemIndex >= 0 ? out[systemIndex] : undefined;
  if (system) {
    out[systemIndex] = { role: 'system', content: `${system.content}\n\n${extra}` };
  } else {
    out.unshift({ role: 'system', content: extra });
  }
  return out;
}

function formatFields(
  mode: StructuredOutputMode,
  outputName: string,
  schema: JsonSchema,
  strict: boolean,
): Record<string, unknown> {
  switch (mode) {
    case 'json_schema':
      return {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: outputName,
            strict: strict && isStrictCompatible(schema),
            schema,
          },
        },
      };
    case 'tool':
      return {
        tools: [
          {
            type: 'function',
            function: {
              name: outputName,
              description: 'Submit the structured result.',
              parameters: schema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: outputName } },
      };
    case 'json_object':
      return { response_format: { type: 'json_object' } };
    case 'prompt':
      return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Reads OpenAI-style usage, including cached prompt and reasoning token details. */
export function readUsage(payload: unknown): DetailedUsage {
  const usage = isRecord(payload) ? payload['usage'] : undefined;
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 };
  const promptDetails = usage['prompt_tokens_details'];
  const completionDetails = usage['completion_tokens_details'];
  const result: DetailedUsage = {
    inputTokens: nonNegativeInt(usage['prompt_tokens']),
    outputTokens: nonNegativeInt(usage['completion_tokens']),
    ...(isRecord(promptDetails) && promptDetails['cached_tokens'] !== undefined
      ? { cachedInputTokens: nonNegativeInt(promptDetails['cached_tokens']) }
      : {}),
    ...(isRecord(completionDetails) && completionDetails['reasoning_tokens'] !== undefined
      ? { reasoningTokens: nonNegativeInt(completionDetails['reasoning_tokens']) }
      : {}),
  };
  return result;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
      .join('');
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function readReply(
  provider: string,
  model: string,
  payload: unknown,
  mode: StructuredOutputMode,
  usage: DetailedUsage,
): string {
  const choices = isRecord(payload) ? payload['choices'] : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice['message'] : undefined;
  const finishReason = isRecord(choice) ? choice['finish_reason'] : undefined;
  const unusable = (issues: string, raw = ''): LlmSchemaError =>
    new LlmSchemaError(provider, {
      model,
      rawOutput: raw,
      issues,
      summary: issues,
      usage,
      repairable: false,
    });

  if (!isRecord(message)) throw unusable('response has no choices[0].message');
  if (typeof message['refusal'] === 'string' && message['refusal'].length > 0) {
    // The refusal text is model output (it can quote the note): not kept.
    throw unusable('model refused');
  }
  if (finishReason === 'content_filter') throw unusable('reply stopped by the content filter');

  let raw: string | undefined;
  if (mode === 'tool') {
    const calls = message['tool_calls'];
    const call: unknown = Array.isArray(calls) ? calls[0] : undefined;
    const fn = isRecord(call) ? call['function'] : undefined;
    if (isRecord(fn) && typeof fn['arguments'] === 'string') raw = fn['arguments'];
  }
  raw ??= contentText(message['content']);
  if (raw === undefined || raw.trim().length === 0) throw unusable('reply is empty');
  if (finishReason === 'length') {
    throw unusable('reply was truncated (finish_reason=length); raise maxOutputTokens', raw);
  }
  return raw;
}

/**
 * The tool call of a native tool-calling reply, as the agent's action
 * object: `{ thought, tool, arguments }` (`arguments` kept as the JSON
 * string the model wrote; the agent validates it per tool). Only the first
 * call counts: one tool per step.
 */
function readToolCall(
  provider: string,
  model: string,
  payload: unknown,
  usage: DetailedUsage,
): string {
  const choices = isRecord(payload) ? payload['choices'] : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice['message'] : undefined;
  const finishReason = isRecord(choice) ? choice['finish_reason'] : undefined;
  const unusable = (issues: string): LlmSchemaError =>
    new LlmSchemaError(provider, {
      model,
      rawOutput: '',
      issues,
      summary: issues,
      usage,
      repairable: false,
    });
  if (!isRecord(message)) throw unusable('response has no choices[0].message');
  if (typeof message['refusal'] === 'string' && message['refusal'].length > 0) {
    throw unusable('model refused');
  }
  if (finishReason === 'content_filter') throw unusable('reply stopped by the content filter');
  const calls = message['tool_calls'];
  const call: unknown = Array.isArray(calls) ? calls[0] : undefined;
  const fn = isRecord(call) ? call['function'] : undefined;
  if (!isRecord(fn) || typeof fn['name'] !== 'string') {
    // No tool call: the model answered in text. Repairable: it is asked again.
    const text = contentText(message['content']) ?? '';
    throw new LlmSchemaError(provider, {
      model,
      rawOutput: text,
      issues: 'reply has no tool call; call exactly one of the tools',
      summary: 'no tool call',
      usage,
      repairable: true,
    });
  }
  const args =
    typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {});
  return JSON.stringify({
    thought: (contentText(message['content']) ?? '').slice(0, 400),
    tool: fn['name'],
    arguments: args,
  });
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

async function httpError(provider: string, response: Response): Promise<LlmProviderError> {
  let message = response.statusText || 'HTTP error';
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : body;
    if (isRecord(error)) {
      if (typeof error['message'] === 'string') message = error['message'];
      const rawCode = error['code'] ?? error['type'];
      if (typeof rawCode === 'string') code = rawCode;
    }
  } catch {
    // Body is not JSON; keep the status text.
  }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  return new LlmProviderError(provider, `HTTP ${String(response.status)}: ${message}`, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    retryable: RETRYABLE_STATUSES.has(response.status),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function transportError(
  provider: string,
  cause: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Error {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    // The gateway aborts with its own timeout error; keep it as is.
    if (reason instanceof LlmProviderError) return reason;
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      return new LlmTimeoutError(provider, timeoutMs ?? 0);
    }
    return new LlmProviderError(provider, 'Request aborted', { retryable: false, cause: reason });
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new LlmProviderError(provider, `Network error: ${detail}`, { retryable: true, cause });
}
