import type { z } from 'zod';
import type { ClinicId } from '../domain/ids.ts';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  /**
   * Images sent with a user message (vision), as `data:` URLs. Providers
   * that read images send them as OpenAI-style `image_url` content parts
   * after the text; the others ignore them.
   */
  readonly images?: readonly { readonly dataUrl: string }[];
}

/**
 * The structured output a call must produce. Adapters send
 * `z.toJSONSchema(schema)` to the model and validate the reply with
 * `schema.parse`, so the domain only ever sees typed, validated output.
 */
export interface StructuredOutput<TOutput> {
  /** Short identifier sent to providers that name response formats, for example `doctor_plan`. */
  readonly name: string;
  readonly schema: z.ZodType<TOutput>;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A tool an agent may call. A provider with native tool calling sends the
 * tools to the model and returns the call it chose as the request's output
 * (an object `{ thought, tool, arguments }`, `arguments` a JSON string); any
 * other provider ignores them, and the same object comes back as plain
 * structured output, the prompt describing the tools. Either way the output
 * schema validates it.
 */
export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
}

/** A request to a single provider. Contains no tenant or patient identifiers. */
export interface LlmCompletionRequest<TOutput> {
  /** Provider-specific model id, for example `meta-models/muse-spark-open-1026`. */
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly output: StructuredOutput<TOutput>;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  /** Tools for an agent step (see {@link LlmToolSpec}). */
  readonly tools?: readonly LlmToolSpec[];
}

export interface LlmCompletion<TOutput> {
  readonly output: TOutput;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
}

/**
 * One LLM vendor (Meta Model API, Baseten, any OpenAI-compatible endpoint,
 * or the fake used in CI). Deliberately has no `clinicId`: tenant ids never
 * reach a model. Throws {@link LlmOutputError} when the reply does not match
 * the schema.
 */
export interface LlmProvider {
  readonly name: string;
  complete<TOutput>(request: LlmCompletionRequest<TOutput>): Promise<LlmCompletion<TOutput>>;
}

/** A request through the gateway: the provider request minus the model, plus accounting labels. */
export interface LlmGatewayRequest<TOutput> extends Omit<LlmCompletionRequest<TOutput>, 'model'> {
  /** What the call is for, for example `plan_extraction`. Selects the model and budget. */
  readonly task: string;
  /** Version of the prompt template, recorded for provenance and evals. */
  readonly promptVersion: string;
}

export interface LlmGatewayResult<TOutput> extends LlmCompletion<TOutput> {
  /** Id of the usage record (tokens, cost, latency) stored for the clinic. */
  readonly callId: string;
  readonly costUsd: number;
}

/**
 * The single entry point for every LLM call in the engine (`llm_gateway`).
 * Picks the provider and model for the task, enforces the clinic's budget,
 * and records tokens, cost and latency per clinic. `clinicId` is used for
 * accounting only and is never sent to the provider.
 */
export interface LlmGateway {
  /** Throws {@link LlmBudgetExceededError} when the clinic's budget is spent. */
  complete<TOutput>(
    clinicId: ClinicId,
    request: LlmGatewayRequest<TOutput>,
  ): Promise<LlmGatewayResult<TOutput>>;
}

/** The model replied, but not with output that matches the schema. */
export class LlmOutputError extends Error {
  override readonly name = 'LlmOutputError';
  readonly provider: string;

  constructor(provider: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.provider = provider;
  }
}

/** The clinic has spent its LLM budget for the current period. */
export class LlmBudgetExceededError extends Error {
  override readonly name = 'LlmBudgetExceededError';
  readonly clinicId: ClinicId;

  constructor(clinicId: ClinicId) {
    super('LLM budget exceeded for clinic');
    this.clinicId = clinicId;
  }
}
