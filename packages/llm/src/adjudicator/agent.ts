import type {
  AdjudicationProviderResult,
  AdjudicationRequest,
  ClinicId,
  ExpectationAdjudicator,
} from '@follow-up-engine/core';
import type { FollowUpLlmGateway } from '../gateway/gateway.ts';
import { quoteFromOriginal } from '../reviewer/agent.ts';
import {
  ADJUDICATION_OUTPUT_NAME,
  ADJUDICATION_PROMPT_VERSION,
  ADJUDICATION_TASK,
  type AdjudicationOutput,
  AdjudicationOutputSchema,
  adjudicationMessages,
} from './prompt.ts';

export interface AdjudicatorOptions {
  readonly gateway: FollowUpLlmGateway;
  /** Gateway task to route (default {@link ADJUDICATION_TASK}). */
  readonly task?: string;
  /** Default 3,000: Muse Spark bills its reasoning as output. */
  readonly maxOutputTokens?: number;
}

/**
 * How far a provider's self-reported probability is pulled toward 0.5
 * (`p' = 0.5 + (p - 0.5) * k`). Language models are over-confident; the
 * factor is fitted on the gold set (`eval:adjudicator` reports the Brier
 * score and the calibration error) and refitted once doctors' overrides
 * give real outcomes. The scripted adjudicator's numbers are kept as is.
 */
export const PROBABILITY_SHRINK: Readonly<Record<string, number>> = {
  fake: 1,
  default: 0.85,
};

export function calibrateProbability(raw: number, provider: string): number {
  const value = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  const shrink = PROBABILITY_SHRINK[provider] ?? PROBABILITY_SHRINK['default'] ?? 1;
  return Math.round((0.5 + (value - 0.5) * shrink) * 1000) / 1000;
}

/**
 * The adjudicator on the `llm_gateway`: one structured-output call per
 * ambiguous item (Muse Spark `muse-spark-1.3`, or the scripted adjudicator
 * on the fake provider). The note and every string of the input are masked
 * before they leave (names, identifiers, delimiter tags); quotes the model
 * copied from the masked note are mapped back to the original text, and the
 * engine then checks them verbatim. Cost, tokens and latency come from the
 * gateway (retries and repair included).
 */
export function createAdjudicator(options: AdjudicatorOptions): ExpectationAdjudicator {
  const task = options.task ?? ADJUDICATION_TASK;
  const maxOutputTokens = options.maxOutputTokens ?? 3_000;
  return {
    async decide(
      clinicId: ClinicId,
      request: AdjudicationRequest,
    ): Promise<AdjudicationProviderResult> {
      const result = await options.gateway.complete<AdjudicationOutput>(clinicId, {
        task,
        promptVersion: ADJUDICATION_PROMPT_VERSION,
        messages: adjudicationMessages(request.input, request.redactTerms),
        output: { name: ADJUDICATION_OUTPUT_NAME, schema: AdjudicationOutputSchema },
        maxOutputTokens,
      });
      const output = result.output;
      return {
        decision: output.decision,
        probability: calibrateProbability(output.probability, result.provider),
        reasonCodes: [...new Set(output.reasonCodes)].slice(0, 4),
        rationale: { en: output.rationaleEn, es: output.rationaleEs },
        quotes: output.quotes
          .slice(0, 3)
          .map((quote) => quoteFromOriginal(request.input.noteText, quote, request.redactTerms)),
        provider: result.provider,
        model: result.model,
        promptVersion: ADJUDICATION_PROMPT_VERSION,
        costUsd: result.totalCostUsd,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        latencyMs: result.latencyMs,
      };
    },
  };
}
