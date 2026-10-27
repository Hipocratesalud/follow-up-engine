import type { LlmCompletion, LlmCompletionRequest, LlmUsage } from '@follow-up-engine/core';

/**
 * Token usage with the optional details OpenAI-style APIs report.
 * `outputTokens` includes reasoning tokens (Muse Spark always reasons, and
 * reasoning is billed as output); `cachedInputTokens` is the part of
 * `inputTokens` served from the prompt cache, billed at the cached rate.
 */
export interface DetailedUsage extends LlmUsage {
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * The provider request as the gateway sends it: the core request plus an
 * abort signal, so a timed-out attempt stops the HTTP call instead of
 * leaking it. Providers in this package honor it; the gateway also races
 * the promise, so a provider that ignores it still cannot hang a call.
 */
export interface ProviderRequest<TOutput> extends LlmCompletionRequest<TOutput> {
  readonly signal?: AbortSignal;
}

export interface ProviderCompletion<TOutput> extends LlmCompletion<TOutput> {
  readonly usage: DetailedUsage;
  /** Raw text the model returned before parsing, kept for repair and debugging. */
  readonly rawOutput?: string;
}

export const ZERO_USAGE: DetailedUsage = { inputTokens: 0, outputTokens: 0 };

export function sumUsage(a: DetailedUsage, b: DetailedUsage): DetailedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}
