import type { ClinicId, LlmGateway, LlmGatewayResult } from '@follow-up-engine/core';
import type { GatewayResult } from '../gateway/gateway.ts';
import type { ConditionTermTable } from './condition-terms.ts';
import { postProcessExtraction } from './post-process.ts';
import { MAX_NOTE_CHARS, prepareNote } from './prepare.ts';
import {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_TASK,
  buildExtractionMessages,
} from './prompt.ts';
import { EXTRACTION_OUTPUT_NAME, ModelExtractionSchema, type ModelExtraction } from './schema.ts';
import type {
  DetailedNoteExtraction,
  ExtractionWarning,
  NoteExtractionInput,
  NoteExtractor,
} from './types.ts';

export interface NoteExtractorOptions {
  /** The single `llm_gateway`; the extractor never talks to a provider directly. */
  readonly gateway: LlmGateway;
  /** Gateway task name. Defaults to `note_extraction`. */
  readonly task?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Longest note sent to the model, in UTF-16 code units. Defaults to {@link MAX_NOTE_CHARS}. */
  readonly maxNoteChars?: number;
  /** Terms that can back each ICD-10 category (see `condition-terms.ts`). */
  readonly conditionTerms?: ConditionTermTable;
}

export interface DetailedNoteExtractor extends NoteExtractor {
  extract(clinicId: ClinicId, input: NoteExtractionInput): Promise<DetailedNoteExtraction>;
}

/**
 * Reads the doctor's plan, conditions and medications out of a free-text
 * note through the `llm_gateway`, then applies deterministic post-checks
 * (verbatim and meaningful evidence, ICD-10 shape, due dates computed in
 * code). Before the call the note is masked (`input.redactTerms`: the
 * patient's names and identifiers never leave), delimiter-shaped tags are
 * neutralized and the note is capped at `maxNoteChars`. Extraction only:
 * nothing it returns is advice, every item is a suggestion to the clinician
 * with its quote. Throws whatever the gateway throws (budget, unavailable
 * provider, unrepairable output) so the caller can retry later.
 */
export function createNoteExtractor(options: NoteExtractorOptions): DetailedNoteExtractor {
  const task = options.task ?? NOTE_EXTRACTION_TASK;

  async function extract(
    clinicId: ClinicId,
    input: NoteExtractionInput,
  ): Promise<DetailedNoteExtraction> {
    const prepared = prepareNote(input.text, {
      ...(input.redactTerms === undefined ? {} : { redactTerms: input.redactTerms }),
      maxChars: options.maxNoteChars ?? MAX_NOTE_CHARS,
    });
    const result: LlmGatewayResult<ModelExtraction> = await options.gateway.complete(clinicId, {
      task,
      promptVersion: NOTE_EXTRACTION_PROMPT_VERSION,
      messages: buildExtractionMessages({
        text: prepared.text,
        authoredAt: input.authoredAt,
        ...(input.specialty === undefined ? {} : { specialty: input.specialty }),
      }),
      output: { name: EXTRACTION_OUTPUT_NAME, schema: ModelExtractionSchema },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
    });
    const processed = postProcessExtraction(
      result.output,
      { prepared, authoredAt: input.authoredAt },
      options.conditionTerms === undefined ? {} : { conditionTerms: options.conditionTerms },
    );
    // The gateway in this package also reports what retries and repair cost.
    const totals =
      'totalCostUsd' in result ? (result as GatewayResult<ModelExtraction>) : undefined;
    const usage = totals?.totalUsage ?? result.usage;
    const warnings: ExtractionWarning[] = [
      ...(prepared.truncated ? (['note_truncated'] as const) : []),
      ...(prepared.redactions > 0 ? (['names_masked'] as const) : []),
      ...(prepared.defanged > 0 ? (['tags_neutralized'] as const) : []),
    ];
    return {
      hasPlan: processed.hasPlan,
      conditions: processed.conditions,
      medications: processed.medications,
      planItems: processed.planItems,
      ...(processed.discharged ? { discharged: true } : {}),
      ...(processed.dischargeEvidenceQuote === undefined
        ? {}
        : { dischargeEvidenceQuote: processed.dischargeEvidenceQuote }),
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
      warnings,
    };
  }

  return { extract };
}
