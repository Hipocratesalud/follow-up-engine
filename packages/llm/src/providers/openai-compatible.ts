import { LlmConfigError } from '../errors.ts';
import {
  createChatCompletionsProvider,
  type FetchLike,
  type StructuredLlmProvider,
  type StructuredOutputMode,
} from './chat-completions.ts';

/** Baseten Model APIs base URL (https://docs.baseten.co/development/model-apis/overview). */
export const BASETEN_BASE_URL = 'https://inference.baseten.co/v1';
/**
 * Muse Spark Open (open weights) on Baseten. Baseten's docs and model page
 * list this slug (https://www.baseten.co/library/muse-spark-open/); the
 * dated id `meta-models/muse-spark-open-1026` from the hackathon brief can
 * be passed as `model` once `GET /v1/models` confirms it.
 */
export const BASETEN_MUSE_SPARK_OPEN_MODEL = 'meta-models/muse-spark-open';

export interface OpenAiCompatibleProviderOptions {
  /** Name used for pricing and logs (`<name>:<model>` in the pricing table). */
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Defaults to `json_schema`. Use `tool` for endpoints without `response_format`. */
  readonly outputMode?: StructuredOutputMode;
  readonly strict?: boolean;
  /** Defaults to `max_tokens`, the field every OpenAI-compatible server accepts. */
  readonly maxTokensParam?: 'max_completion_tokens' | 'max_tokens';
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: Baseten, Together,
 * Fireworks, vLLM, OpenAI itself. Lets the eval harness benchmark other
 * models with the same prompt and the same metrics.
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleProviderOptions,
): StructuredLlmProvider {
  if (options.apiKey.trim() === '') {
    throw new LlmConfigError(`API key for ${options.name ?? 'openai-compatible'} is empty`);
  }
  return createChatCompletionsProvider({
    name: options.name ?? 'openai-compatible',
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    outputMode: options.outputMode ?? 'json_schema',
    maxTokensParam: options.maxTokensParam ?? 'max_tokens',
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    ...(options.extraBody ? { extraBody: options.extraBody } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

export interface BasetenProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /**
   * Defaults to `tool`: Baseten documents tool calling for every Model API
   * but structured outputs and JSON mode for every model *except* Muse Spark
   * Open (https://docs.baseten.co/development/model-apis/overview, checked
   * 2026-10-26). Switch to `json_schema` once that changes.
   */
  readonly outputMode?: StructuredOutputMode;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/** Muse Spark Open on Baseten Model APIs (OpenAI-compatible). */
export function createBasetenProvider(options: BasetenProviderOptions): StructuredLlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'baseten',
    baseUrl: options.baseUrl ?? BASETEN_BASE_URL,
    apiKey: options.apiKey,
    outputMode: options.outputMode ?? 'tool',
    ...(options.extraBody ? { extraBody: options.extraBody } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
