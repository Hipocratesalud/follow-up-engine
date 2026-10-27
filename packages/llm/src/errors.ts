import { LlmOutputError } from '@follow-up-engine/core';
import type { DetailedUsage } from './usage.ts';

/**
 * A provider call failed before producing a usable reply: HTTP error,
 * network failure or timeout. `retryable` tells the gateway whether the same
 * request may succeed later (429, 5xx, network, timeout); other failures
 * (400, 401, 402, 403, 404, 413) need the request or the account fixed.
 */
export class LlmProviderError extends Error {
  override readonly name: string = 'LlmProviderError';
  readonly provider: string;
  /** HTTP status, when the failure was an HTTP response. */
  readonly status: number | undefined;
  /** Vendor error type or code (for example `rate_limit_error`), when the body had one. */
  readonly code: string | undefined;
  readonly retryable: boolean;
  /** Server hint from `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    message: string,
    details: {
      readonly status?: number;
      readonly code?: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.provider = provider;
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/** The call did not finish within its time budget. Retryable. */
export class LlmTimeoutError extends LlmProviderError {
  override readonly name = 'LlmTimeoutError';

  constructor(provider: string, timeoutMs: number) {
    super(provider, `LLM call timed out after ${String(timeoutMs)} ms`, { retryable: true });
  }
}

/**
 * The model replied, but the reply is not valid JSON for the requested
 * schema. Carries the raw reply and the validation issues so the gateway can
 * ask the model to repair it once, and the usage so the failed call is still
 * accounted for.
 */
export class LlmSchemaError extends LlmOutputError {
  readonly rawOutput: string;
  readonly issues: string;
  readonly usage: DetailedUsage;
  readonly model: string;
  /**
   * Whether re-asking with the validation error can help. False for
   * truncated replies, refusals and content-filter stops.
   */
  readonly repairable: boolean;

  constructor(
    provider: string,
    details: {
      readonly model: string;
      readonly rawOutput: string;
      readonly issues: string;
      readonly usage: DetailedUsage;
      readonly repairable: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(provider, `Model output does not match the schema: ${details.issues}`, {
      cause: details.cause,
    });
    this.model = details.model;
    this.rawOutput = details.rawOutput;
    this.issues = details.issues;
    this.usage = details.usage;
    this.repairable = details.repairable;
  }
}

/** Every provider in a task's route failed. `cause` is the last error. */
export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';
  readonly task: string;
  readonly attempts: readonly {
    readonly provider: string;
    readonly model: string;
    readonly error: string;
  }[];

  constructor(
    task: string,
    attempts: readonly {
      readonly provider: string;
      readonly model: string;
      readonly error: string;
    }[],
    cause: unknown,
  ) {
    super(
      `All providers failed for task ${task}: ${attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join('; ')}`,
      { cause },
    );
    this.task = task;
    this.attempts = attempts;
  }
}

/** Gateway or provider configuration is invalid (unknown task, unpriced model, missing key). */
export class LlmConfigError extends Error {
  override readonly name = 'LlmConfigError';
}

/** A short, log-safe description of any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof LlmProviderError) {
    const status = error.status === undefined ? '' : ` ${String(error.status)}`;
    return `${error.name}${status}: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
