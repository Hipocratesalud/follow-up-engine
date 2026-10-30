import type { FindingText, ReviewLocale } from '../domain/clinical-finding.ts';
import type { ClinicId } from '../domain/ids.ts';

/**
 * Translates a finding's own words (summary, rationale, suggestion) between
 * review locales, for a finding the reviewing model wrote in one language
 * only. Implemented in `@follow-up-engine/llm` on the `llm_gateway`. It gets
 * the three texts and nothing else: no record, no quote, no identifier (the
 * patient's names are masked before the call).
 */
export interface FindingTranslationRequest {
  readonly from: ReviewLocale;
  readonly to: ReviewLocale;
  readonly text: FindingText;
  /** The patient's names and identifiers, masked in the text before it leaves. */
  readonly redactTerms: readonly string[];
}

export interface FindingTranslation {
  readonly text: FindingText;
  /** `<provider>:<model>`. */
  readonly modelId: string;
  readonly costUsd: number;
}

export interface FindingTranslator {
  translate(clinicId: ClinicId, request: FindingTranslationRequest): Promise<FindingTranslation>;
}
