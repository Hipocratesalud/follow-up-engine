import type { ClinicDirectory, Clock, LlmUsageLog, NoteExtractor } from '@follow-up-engine/core';
import {
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  chainResponders,
  createBasetenProvider,
  createFakeProvider,
  createLlmGateway,
  createMetaProvider,
  createNoteExtractor,
  createNoteFixtureResponder,
  createOpenAiCompatibleProvider,
  DEFAULT_PRICING,
  FAKE_DEFAULT_MODEL,
  heuristicResponder,
  META_DEFAULT_MODEL,
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_TASK,
  type NoteFixture,
  type PricingTable,
  type StructuredLlmProvider,
} from '@follow-up-engine/llm';
import type { LlmConfig } from '../config.ts';

/** Which provider and model read the notes, as shown in the inbox stats. */
export interface ExtractorInfo {
  readonly provider: string;
  readonly model: string;
}

export interface ConfiguredExtractor {
  readonly extractor: NoteExtractor;
  readonly info: ExtractorInfo;
}

export interface ExtractorDeps {
  readonly usageLog: LlmUsageLog;
  readonly clinics: ClinicDirectory;
  readonly clock: Clock;
  /**
   * Scripted readings for known notes (fake provider only): tests and seeds
   * pass gold or scenario fixtures; any other note falls back to the
   * rule-based heuristic reader.
   */
  readonly noteFixtures?: readonly NoteFixture[];
}

interface ProviderChoice {
  readonly provider: StructuredLlmProvider;
  readonly info: ExtractorInfo;
  readonly pricing: PricingTable;
}

function chooseProvider(config: LlmConfig, deps: ExtractorDeps): ProviderChoice {
  switch (config.provider) {
    case 'meta':
      return {
        provider: createMetaProvider({
          apiKey: config.metaApiKey ?? '',
          promptCacheKey: NOTE_EXTRACTION_PROMPT_VERSION,
        }),
        info: { provider: 'meta', model: config.metaModel ?? META_DEFAULT_MODEL },
        pricing: DEFAULT_PRICING,
      };
    case 'baseten':
      return {
        provider: createBasetenProvider({ apiKey: config.basetenApiKey ?? '' }),
        info: { provider: 'baseten', model: config.basetenModel ?? BASETEN_MUSE_SPARK_OPEN_MODEL },
        pricing: DEFAULT_PRICING,
      };
    case 'openai-compatible': {
      const settings = config.openAiCompatible;
      if (settings === undefined) {
        throw new Error('LLM_PROVIDER=openai-compatible needs OPENAI_COMPATIBLE_* settings');
      }
      return {
        provider: createOpenAiCompatibleProvider({
          name: 'openai-compatible',
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
        }),
        info: { provider: 'openai-compatible', model: settings.model },
        pricing: {
          ...DEFAULT_PRICING,
          [`openai-compatible:${settings.model}`]: {
            inputPerMTok: settings.priceInPerMTok,
            outputPerMTok: settings.priceOutPerMTok,
            source: 'OPENAI_COMPATIBLE_PRICE_* environment variables',
          },
        },
      };
    }
    case 'fake':
      return {
        provider: createFakeProvider({
          respond: chainResponders(
            createNoteFixtureResponder(deps.noteFixtures ?? []),
            heuristicResponder,
          ),
        }),
        info: { provider: 'fake', model: FAKE_DEFAULT_MODEL },
        pricing: DEFAULT_PRICING,
      };
  }
}

/**
 * Builds the `NoteExtractor` the engine reads doctors' plans with: the
 * `llm_gateway` routed to the one provider `LLM_PROVIDER` names (no silent
 * fallback to another vendor), accounted in the clinic's `LlmUsageLog` and
 * capped by its monthly budget (`ClinicSettings.llmMonthlyBudgetUsd`).
 */
export function createConfiguredExtractor(
  config: LlmConfig,
  deps: ExtractorDeps,
): ConfiguredExtractor {
  const choice = chooseProvider(config, deps);
  const gateway = createLlmGateway({
    providers: { [choice.info.provider]: choice.provider },
    tasks: {
      [NOTE_EXTRACTION_TASK]: {
        route: [{ provider: choice.info.provider, model: choice.info.model }],
        maxOutputTokens: 8_000,
      },
    },
    usageLog: deps.usageLog,
    pricing: choice.pricing,
    monthlyBudgetUsd: async (clinicId) =>
      (await deps.clinics.get(clinicId))?.settings.llmMonthlyBudgetUsd,
    clock: deps.clock,
  });
  return { extractor: createNoteExtractor({ gateway }), info: choice.info };
}
