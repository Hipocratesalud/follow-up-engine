import type {
  ClinicalReviewAgent,
  ClinicDirectory,
  Clock,
  LlmUsageLog,
  NoteExtractor,
} from '@follow-up-engine/core';
import {
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  chainResponders,
  CLINICAL_REVIEW_TASK,
  createBasetenProvider,
  createFakeProvider,
  createLlmGateway,
  createMetaProvider,
  createNoteExtractor,
  createNoteFixtureResponder,
  createOpenAiCompatibleProvider,
  createReviewAgent,
  createSnapshotProvider,
  DEFAULT_PRICING,
  type FetchLike,
  FAKE_DEFAULT_MODEL,
  FAKE_REVIEWER_MODEL,
  heuristicResponder,
  type LlmSnapshot,
  type LlmSnapshotEntry,
  META_DEFAULT_MODEL,
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_TASK,
  type NoteFixture,
  type PricingTable,
  scriptedReviewerResponder,
  type SnapshotProvider,
  type StructuredLlmProvider,
} from '@follow-up-engine/llm';
import type { LlmConfig } from './config.ts';

/** Which provider and model read the notes, as shown in the inbox stats. */
export interface ExtractorInfo {
  readonly provider: string;
  readonly model: string;
}

export interface ConfiguredExtractor {
  readonly extractor: NoteExtractor;
  readonly info: ExtractorInfo;
  /** The clinical reviewer's agent, on the same gateway, provider and budget. */
  readonly reviewAgent: ClinicalReviewAgent;
  /** Model the reviewer runs on (the scripted reviewer on the fake provider). */
  readonly reviewerModel: string;
  /** The recorded replies being replayed, when a snapshot of this provider was given. */
  readonly replay?: Pick<SnapshotProvider, 'stats' | 'snapshot'>;
}

/**
 * Replies a model gave once (`packages/testkit/fixtures/llm-snapshots`),
 * replayed instead of calling it again: the demo's initial backfill reads
 * hundreds of notes with Muse Spark's own readings in seconds. Only used
 * when the snapshot's provider is the configured one; any request not in
 * it (a new note, a new prompt version) calls the model, and the reply is
 * passed to `onRecord`.
 */
export interface LlmSnapshotOption {
  readonly snapshot: LlmSnapshot;
  /**
   * Whether a request not in the snapshot may call the model now. When
   * given, such a request is answered instead by the fake provider (the
   * rule-based reader, the scripted reviewer) as the gateway's fallback
   * route, and accounted and labeled as `fake`: the demo seed never spends
   * on a stale snapshot, and never passes a fake reading off as Muse Spark.
   */
  readonly allowLive?: () => boolean;
  readonly onRecord?: (key: string, entry: LlmSnapshotEntry) => void;
  readonly onReplay?: (key: string, entry: LlmSnapshotEntry) => void;
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
  readonly snapshot?: LlmSnapshotOption;
  /** HTTP client of the real providers (tests). */
  readonly llmFetch?: FetchLike;
}

interface ProviderChoice {
  readonly provider: StructuredLlmProvider;
  readonly info: ExtractorInfo;
  readonly pricing: PricingTable;
  /** The reviewer's model when it differs from the extractor's (the fake's scripted reviewer). */
  readonly reviewerModel?: string;
}

function chooseProvider(config: LlmConfig, deps: ExtractorDeps): ProviderChoice {
  switch (config.provider) {
    case 'meta':
      return {
        // Native tool calling for the reviewer's agent steps; extraction uses json_schema.
        provider: createMetaProvider({
          apiKey: config.metaApiKey ?? '',
          promptCacheKey: NOTE_EXTRACTION_PROMPT_VERSION,
          toolCalling: 'native',
          ...(deps.llmFetch === undefined ? {} : { fetch: deps.llmFetch }),
        }),
        info: { provider: 'meta', model: config.metaModel ?? META_DEFAULT_MODEL },
        pricing: DEFAULT_PRICING,
      };
    case 'baseten':
      return {
        provider: createBasetenProvider({
          apiKey: config.basetenApiKey ?? '',
          ...(deps.llmFetch === undefined ? {} : { fetch: deps.llmFetch }),
        }),
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
          ...(deps.llmFetch === undefined ? {} : { fetch: deps.llmFetch }),
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
            scriptedReviewerResponder,
            createNoteFixtureResponder(deps.noteFixtures ?? []),
            heuristicResponder,
          ),
        }),
        info: { provider: 'fake', model: FAKE_DEFAULT_MODEL },
        pricing: DEFAULT_PRICING,
        reviewerModel: FAKE_REVIEWER_MODEL,
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
  const replay =
    deps.snapshot !== undefined &&
    choice.info.provider !== 'fake' &&
    deps.snapshot.snapshot.provider === choice.info.provider
      ? createSnapshotProvider({
          snapshot: deps.snapshot.snapshot,
          live: choice.provider,
          ...(deps.snapshot.onRecord === undefined ? {} : { onRecord: deps.snapshot.onRecord }),
          ...(deps.snapshot.onReplay === undefined ? {} : { onReplay: deps.snapshot.onReplay }),
          ...(deps.snapshot.allowLive === undefined ? {} : { allowLive: deps.snapshot.allowLive }),
        })
      : undefined;
  // Only next to a replay-only snapshot: the fake answers what the snapshot cannot.
  const fallback =
    replay !== undefined && deps.snapshot?.allowLive !== undefined
      ? chooseProvider({ provider: 'fake' }, deps)
      : undefined;
  const gateway = createLlmGateway({
    providers: {
      [choice.info.provider]: replay ?? choice.provider,
      ...(fallback === undefined ? {} : { [fallback.info.provider]: fallback.provider }),
    },
    tasks: {
      [NOTE_EXTRACTION_TASK]: {
        route: [
          { provider: choice.info.provider, model: choice.info.model },
          ...(fallback === undefined ? [] : [fallback.info]),
        ],
        maxOutputTokens: 8_000,
      },
      [CLINICAL_REVIEW_TASK]: {
        route: [
          { provider: choice.info.provider, model: choice.reviewerModel ?? choice.info.model },
          ...(fallback === undefined
            ? []
            : [{ provider: fallback.info.provider, model: fallback.reviewerModel ?? '' }]),
        ],
        maxOutputTokens: 4_000,
      },
    },
    usageLog: deps.usageLog,
    pricing: choice.pricing,
    monthlyBudgetUsd: async (clinicId) =>
      (await deps.clinics.get(clinicId))?.settings.llmMonthlyBudgetUsd,
    clock: deps.clock,
  });
  return {
    extractor: createNoteExtractor({ gateway }),
    info: choice.info,
    reviewAgent: createReviewAgent({ gateway }),
    reviewerModel: choice.reviewerModel ?? choice.info.model,
    ...(replay === undefined ? {} : { replay }),
  };
}
