import { LlmProviderError } from '../errors.ts';

export interface RetryPolicy {
  /** Attempts per provider, including the first. */
  readonly maxAttempts: number;
  /** First backoff delay; doubles on each retry. */
  readonly baseDelayMs: number;
  /** Cap on a single delay, including a server `Retry-After`. */
  readonly maxDelayMs: number;
}

/**
 * Defaults follow the Meta Model API guidance
 * (https://dev.meta.ai/docs/error-handling): start around 0.5–1 s, double
 * each retry, add up to 1 s of jitter, 3–5 attempts.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Whether an error is transient (429, 5xx, network, timeout). */
export function isRetryable(error: unknown): error is LlmProviderError {
  return error instanceof LlmProviderError && error.retryable;
}

/**
 * Delay before retry number `retry` (1-based): exponential backoff plus
 * jitter in `[0, baseDelayMs)`, or the server's `Retry-After` when it sent
 * one. Both are capped at `maxDelayMs`.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  retry: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const exponential = policy.baseDelayMs * 2 ** (retry - 1);
  const base = retryAfterMs ?? exponential;
  const jitter = random() * policy.baseDelayMs;
  return Math.min(policy.maxDelayMs, base + jitter);
}
