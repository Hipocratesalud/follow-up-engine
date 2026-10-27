import { LlmConfigError } from '../errors.ts';
import {
  createChatCompletionsProvider,
  type FetchLike,
  type StructuredLlmProvider,
  type StructuredOutputMode,
} from './chat-completions.ts';

/** Meta Model API base URL (https://dev.meta.ai/docs/quickstart). */
export const META_API_BASE_URL = 'https://api.meta.ai/v1';
/** Default Muse Spark model (https://dev.meta.ai/docs/models). */
export const META_DEFAULT_MODEL = 'muse-spark-1.3';

/** Muse Spark always reasons; `none` is rejected with HTTP 400. */
export type MetaReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface MetaProviderOptions {
  /** Meta Model API key (`Authorization: Bearer`). The docs call it `MODEL_API_KEY`; apps read `META_API_KEY`. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /**
   * Reasoning depth. Defaults to `low`: extraction is reading, not
   * problem solving, and reasoning tokens are billed as output.
   */
  readonly reasoningEffort?: MetaReasoningEffort;
  /** Defaults to `json_schema` (strict when the schema allows it). */
  readonly outputMode?: StructuredOutputMode;
  /**
   * Routes requests that share a prompt prefix to the same cache
   * (`prompt_cache_key`). The extraction system prompt is long and constant,
   * so cached input is billed at $0.15 instead of $1.25 per 1M tokens.
   */
  readonly promptCacheKey?: string;
  /**
   * Allow `*-contributor` model ids. Contributor mode is ~10x cheaper but
   * grants Meta the right to train on prompts and replies
   * (https://dev.meta.ai/docs/pricing-rate-limits), so it is refused by
   * default: clinical notes must never be sent under it. Only for synthetic
   * evals.
   */
  readonly allowContributorMode?: boolean;
  /** How agent steps with tools are sent (default `native`, see `ChatCompletionsProviderOptions`). */
  readonly toolCalling?: 'native' | 'structured';
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

/**
 * Muse Spark through the Meta Model API, over its OpenAI-compatible Chat
 * Completions protocol (`POST /v1/chat/completions`,
 * https://dev.meta.ai/docs/protocols/chat-completions) with
 * `response_format: json_schema` structured output
 * (https://dev.meta.ai/docs/structured-output).
 */
export function createMetaProvider(options: MetaProviderOptions): StructuredLlmProvider {
  if (options.apiKey.trim() === '') {
    throw new LlmConfigError('Meta Model API key is empty: set META_API_KEY');
  }
  const inner = createChatCompletionsProvider({
    name: 'meta',
    baseUrl: options.baseUrl ?? META_API_BASE_URL,
    apiKey: options.apiKey,
    outputMode: options.outputMode ?? 'json_schema',
    maxTokensParam: 'max_completion_tokens',
    ...(options.toolCalling === undefined ? {} : { toolCalling: options.toolCalling }),
    // Only `auto` is accepted ("required" and named choices are a 400); a
    // text reply without a call is re-asked by the gateway's repair.
    toolChoice: 'auto',
    extraBody: {
      reasoning_effort: options.reasoningEffort ?? 'low',
      ...(options.promptCacheKey === undefined ? {} : { prompt_cache_key: options.promptCacheKey }),
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    name: inner.name,
    complete(request) {
      if (isContributorModel(request.model) && options.allowContributorMode !== true) {
        return Promise.reject(
          new LlmConfigError(
            `${request.model} is a Contributor-mode model (Meta may train on the data); refused for clinical data`,
          ),
        );
      }
      return inner.complete(request);
    },
  };
}

/** Contributor-mode model ids end in `-contributor` (`muse-spark-1.3-contributor`). */
export function isContributorModel(model: string): boolean {
  return model.endsWith('-contributor');
}
