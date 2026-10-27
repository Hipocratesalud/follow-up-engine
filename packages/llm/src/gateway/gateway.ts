import {
  LlmBudgetExceededError,
  type ClinicId,
  type Clock,
  type LlmCompletion,
  type LlmGateway,
  type LlmGatewayRequest,
  type LlmGatewayResult,
  type LlmMessage,
  type LlmProvider,
} from '@follow-up-engine/core';
import { z } from 'zod';
import {
  LlmConfigError,
  LlmSchemaError,
  LlmTimeoutError,
  LlmUnavailableError,
  describeError,
} from '../errors.ts';
import {
  DEFAULT_PRICING,
  costOf,
  priceFor,
  type ModelPrice,
  type PricingTable,
} from '../pricing.ts';
import type { StructuredLlmProvider } from '../providers/chat-completions.ts';
import type { LlmUsageLog } from '../usage-log.ts';
import { issueSummary } from '../providers/structured-output.ts';
import { ZERO_USAGE, sumUsage, type DetailedUsage, type ProviderCompletion } from '../usage.ts';
import { DEFAULT_RETRY_POLICY, backoffDelayMs, isRetryable, type RetryPolicy } from './retry.ts';

/** One provider + model a task can run on. */
export interface RouteTarget {
  /** Key in {@link LlmGatewayConfig.providers}, also the pricing prefix (`meta`, `baseten`, `fake`). */
  readonly provider: string;
  readonly model: string;
}

export interface TaskConfig {
  /** Primary target first, then fallbacks tried in order when it fails. */
  readonly route: readonly [RouteTarget, ...RouteTarget[]];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Per-attempt timeout. Defaults to {@link LlmGatewayConfig.defaultTimeoutMs}. */
  readonly timeoutMs?: number;
}

export interface LlmGatewayConfig {
  readonly providers: Readonly<Record<string, LlmProvider | StructuredLlmProvider>>;
  /** Task name (for example `note_extraction`) to its route and limits. */
  readonly tasks: Readonly<Record<string, TaskConfig>>;
  readonly usageLog: LlmUsageLog;
  /** Defaults to {@link DEFAULT_PRICING}. Every routed model must have a price. */
  readonly pricing?: PricingTable;
  /**
   * The clinic's monthly LLM budget in USD (`ClinicSettings.llmMonthlyBudgetUsd`),
   * or `undefined` for no cap. Spend is summed from the usage log since the
   * start of the current UTC month.
   */
  readonly monthlyBudgetUsd?: (
    clinicId: ClinicId,
  ) => Promise<number | undefined> | number | undefined;
  readonly retry?: Partial<RetryPolicy>;
  /** Defaults to 90 s: Muse Spark always reasons before answering. */
  readonly defaultTimeoutMs?: number;
  readonly clock?: Clock;
  /** Injected for tests; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Math.random`. Drives backoff jitter. */
  readonly random?: () => number;
  readonly newCallId?: () => string;
  /** Monotonic milliseconds for latency; defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/** The gateway result, with the detailed token usage of the successful call. */
export interface GatewayResult<TOutput> extends LlmGatewayResult<TOutput> {
  readonly usage: DetailedUsage;
  /** Number of provider calls made (retries, repair and fallbacks included). */
  readonly attempts: number;
  /** Whether the output needed one repair round trip. */
  readonly repaired: boolean;
  /** Cost of every provider call made for this request (failed attempts and repair included). */
  readonly totalCostUsd: number;
  /** Token usage summed over every provider call made for this request. */
  readonly totalUsage: DetailedUsage;
}

export interface FollowUpLlmGateway extends LlmGateway {
  complete<TOutput>(
    clinicId: ClinicId,
    request: LlmGatewayRequest<TOutput>,
  ): Promise<GatewayResult<TOutput>>;
}

/** Start of the UTC calendar month that contains `now`. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Text appended to the conversation when the first reply fails validation. */
export function repairInstruction(issues: string): string {
  return [
    'Your previous reply did not pass validation against the required JSON Schema:',
    issues,
    'Reply again with the complete, corrected JSON object only.',
    'Keep every value that was already valid; quotes must stay verbatim from the note.',
  ].join('\n');
}

function sleepWithTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `llm_gateway`: the only way the engine calls a model.
 *
 * Per call it: resolves the task's route, refuses before calling when the
 * clinic's monthly budget is spent, runs each attempt under a timeout,
 * retries transient failures with exponential backoff and jitter, validates
 * the output with zod and asks the model to repair it once, falls back to
 * the next provider in the route, and records every provider call (tokens,
 * cost, latency, outcome) in the usage log. The `clinicId` is used for
 * accounting only: it is never part of what a provider receives.
 */
export function createLlmGateway(config: LlmGatewayConfig): FollowUpLlmGateway {
  const pricing = config.pricing ?? DEFAULT_PRICING;
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
  const now = (): Date => config.clock?.now() ?? new Date();
  const sleep = config.sleep ?? sleepWithTimeout;
  const random = config.random ?? Math.random;
  const newCallId = config.newCallId ?? (() => globalThis.crypto.randomUUID());
  const monotonicNow = config.monotonicNow ?? (() => performance.now());

  if (retry.maxAttempts < 1) throw new LlmConfigError('retry.maxAttempts must be at least 1');
  const prices = new Map<string, ModelPrice>();
  for (const [task, taskConfig] of Object.entries(config.tasks)) {
    for (const target of taskConfig.route) {
      if (!(target.provider in config.providers)) {
        throw new LlmConfigError(`Task ${task} routes to unknown provider ${target.provider}`);
      }
      const price = priceFor(pricing, target.provider, target.model);
      if (!price) {
        throw new LlmConfigError(
          `No price for ${target.provider}:${target.model} (task ${task}); add it to the pricing table`,
        );
      }
      prices.set(`${target.provider}:${target.model}`, price);
    }
  }

  async function enforceBudget(clinicId: ClinicId): Promise<void> {
    const limit = await config.monthlyBudgetUsd?.(clinicId);
    if (limit === undefined) return;
    const spent = await config.usageLog.totalCostUsd(clinicId, startOfUtcMonth(now()));
    if (spent >= limit) throw new LlmBudgetExceededError(clinicId);
  }

  async function complete<TOutput>(
    clinicId: ClinicId,
    request: LlmGatewayRequest<TOutput>,
  ): Promise<GatewayResult<TOutput>> {
    const task = config.tasks[request.task];
    if (!task) throw new LlmConfigError(`Unknown LLM task ${request.task}`);
    await enforceBudget(clinicId);

    let attempts = 0;
    let totalCostUsd = 0;
    let totalUsage: DetailedUsage = ZERO_USAGE;
    const failures: { provider: string; model: string; error: string }[] = [];
    let lastError: unknown;

    for (const target of task.route) {
      const provider = config.providers[target.provider];
      const price = prices.get(`${target.provider}:${target.model}`);
      if (!provider || !price) continue; // validated at construction
      const timeoutMs =
        request.timeoutMs ?? task.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const temperature = request.temperature ?? task.temperature;
      const maxOutputTokens = request.maxOutputTokens ?? task.maxOutputTokens;

      /** One provider call under a timeout, always recorded in the usage log. */
      const callOnce = async (messages: readonly LlmMessage[]): Promise<GatewayResult<TOutput>> => {
        attempts += 1;
        const callId = newCallId();
        const at = now();
        const started = monotonicNow();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new LlmTimeoutError(target.provider, timeoutMs);
            // Reject first so the race reports the timeout, not the provider's abort error.
            reject(error);
            controller.abort(error);
          }, timeoutMs);
        });
        const record = async (
          usage: DetailedUsage,
          ok: boolean,
          error?: unknown,
        ): Promise<{ costUsd: number; latencyMs: number }> => {
          const latencyMs = Math.round(monotonicNow() - started);
          const costUsd = costOf(price, usage);
          totalCostUsd += costUsd;
          totalUsage = sumUsage(totalUsage, usage);
          await config.usageLog.record({
            callId,
            clinicId,
            task: request.task,
            promptVersion: request.promptVersion,
            provider: target.provider,
            model: target.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd,
            latencyMs,
            ok,
            ...(error === undefined ? {} : { error: describeError(error) }),
            at,
          });
          return { costUsd, latencyMs };
        };

        try {
          // Built field by field: nothing tenant-scoped can leak to the provider.
          const completion: LlmCompletion<TOutput> | ProviderCompletion<TOutput> =
            await Promise.race([
              provider.complete({
                model: target.model,
                messages,
                output: request.output,
                ...(temperature === undefined ? {} : { temperature }),
                ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
                ...(request.tools === undefined ? {} : { tools: request.tools }),
                timeoutMs,
                signal: controller.signal,
              }),
              timeout,
            ]);
          const usage: DetailedUsage = completion.usage;
          // Defense in depth: never trust a provider to have validated.
          const checked = request.output.schema.safeParse(completion.output);
          if (!checked.success) {
            const raw =
              (completion as Partial<ProviderCompletion<TOutput>>).rawOutput ??
              JSON.stringify(completion.output);
            throw new LlmSchemaError(target.provider, {
              model: target.model,
              rawOutput: raw,
              issues: z.prettifyError(checked.error),
              summary: issueSummary(checked.error),
              usage,
              repairable: true,
            });
          }
          const { costUsd, latencyMs } = await record(usage, true);
          return {
            output: checked.data,
            usage,
            latencyMs,
            provider: target.provider,
            model: target.model,
            callId,
            costUsd,
            attempts,
            repaired: false,
            totalCostUsd,
            totalUsage,
          };
        } catch (error) {
          await record(error instanceof LlmSchemaError ? error.usage : ZERO_USAGE, false, error);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      };

      const callWithRetry = async (
        messages: readonly LlmMessage[],
      ): Promise<GatewayResult<TOutput>> => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await callOnce(messages);
          } catch (error) {
            if (!isRetryable(error) || attempt >= retry.maxAttempts) throw error;
            await sleep(backoffDelayMs(retry, attempt, random, error.retryAfterMs));
          }
        }
      };

      try {
        try {
          return await callWithRetry(request.messages);
        } catch (error) {
          if (!(error instanceof LlmSchemaError) || !error.repairable) throw error;
          const repaired = await callWithRetry([
            ...request.messages,
            { role: 'assistant', content: error.rawOutput },
            { role: 'user', content: repairInstruction(error.issues) },
          ]);
          return { ...repaired, attempts, repaired: true, totalCostUsd, totalUsage };
        }
      } catch (error) {
        lastError = error;
        failures.push({
          provider: target.provider,
          model: target.model,
          error: describeError(error),
        });
      }
    }

    if (task.route.length === 1) throw lastError;
    throw new LlmUnavailableError(request.task, failures, lastError);
  }

  return { complete };
}
