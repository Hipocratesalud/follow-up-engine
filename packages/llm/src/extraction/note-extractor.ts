import type { ClinicId, LlmGateway, LlmGatewayResult } from '@follow-up-engine/core';
import type { GatewayResult } from '../gateway/gateway.ts';
import { postProcessExtraction } from './post-process.ts';
import {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_TASK,
  buildExtractionMessages,
} from './prompt.ts';
import { EXTRACTION_OUTPUT_NAME, ModelExtractionSchema, type ModelExtraction } from './schema.ts';
import type { DetailedNoteExtraction, NoteExtractionInput, NoteExtractor } from './types.ts';

export interface NoteExtractorOptions {
  /** The single `llm_gateway`; the extractor never talks to a provider directly. */
  readonly gateway: LlmGateway;
  /** Gateway task name. Defaults to `note_extraction`. */
  readonly task?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface DetailedNoteExtractor extends NoteExtractor {
  extract(clinicId: ClinicId, input: NoteExtractionInput): Promise<DetailedNoteExtraction>;
}

/**
 * Reads the doctor's plan, conditions and medications out of a free-text
 * note through the `llm_gateway`, then applies deterministic post-checks
 * (verbatim evidence, ICD-10 shape, due dates computed in code). Extraction
 * only: nothing it returns is advice, every item is a suggestion to the
 * clinician with its quote. Throws whatever the gateway throws (budget,
 * unavailable provider, unrepairable output) so the caller can retry later.
 */
export function createNoteExtractor(options: NoteExtractorOptions): DetailedNoteExtractor {
  const task = options.task ?? NOTE_EXTRACTION_TASK;

  async function extract(
    clinicId: ClinicId,
    input: NoteExtractionInput,
  ): Promise<DetailedNoteExtraction> {
    const result: LlmGatewayResult<ModelExtraction> = await options.gateway.complete(clinicId, {
      task,
      promptVersion: NOTE_EXTRACTION_PROMPT_VERSION,
      messages: buildExtractionMessages(input),
      output: { name: EXTRACTION_OUTPUT_NAME, schema: ModelExtractionSchema },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
    });
    const processed = postProcessExtraction(result.output, input);
    // The gateway in this package also reports what retries and repair cost.
    const totals =
      'totalCostUsd' in result ? (result as GatewayResult<ModelExtraction>) : undefined;
    const usage = totals?.totalUsage ?? result.usage;
    return {
      hasPlan: processed.hasPlan,
      conditions: processed.conditions,
      medications: processed.medications,
      planItems: processed.planItems,
      model: result.model,
      promptVersion: NOTE_EXTRACTION_PROMPT_VERSION,
      costUsd: totals?.totalCostUsd ?? result.costUsd,
      provider: result.provider,
      callId: result.callId,
      latencyMs: result.latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      modelItemCount: processed.modelItemCount,
      rejected: processed.rejected,
    };
  }

  return { extract };
}
