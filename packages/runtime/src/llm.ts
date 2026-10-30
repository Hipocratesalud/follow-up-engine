import type {
  RuleAuthoringAgent,
  ClinicalReviewAgent,
  ClinicDirectory,
  ClinicId,
  Clock,
  ExpectationAdjudicator,
  FindingTranslator,
  LlmUsageLog,
  NoteExtractor,
  OrderAgentModel,
  PatientMediaReader,
} from '@follow-up-engine/core';
import {
  ADJUDICATION_TASK,
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  chainResponders,
  CLINICAL_REVIEW_TASK,
  createFindingTranslator,
  FINDING_TRANSLATION_TASK,
  createAdjudicator,
  createBasetenProvider,
  createFakeProvider,
  createLlmGateway,
  createMetaProvider,
  createNoteExtractor,
  createNoteFixtureResponder,
  createOpenAiCompatibleProvider,
  createFakeTranscriber,
  createMetaTranscriber,
  createOrderAgentModel,
  createPatientMediaReader,
  createReviewAgent,
  createScriptedLabDocumentResponder,
  createScriptedLabPhotoResponder,
  createSnapshotProvider,
  DEFAULT_PRICING,
  type FetchLike,
  FAKE_ADJUDICATOR_MODEL,
  FAKE_DEFAULT_MODEL,
  FAKE_ORDER_AGENT_MODEL,
  FAKE_REVIEWER_MODEL,
  FAKE_TRANSCRIBER_MODEL,
  FAKE_VISION_MODEL,
  LAB_DOCUMENT_SCRIPTED_TASK,
  LAB_DOCUMENT_TASK,
  LAB_PHOTO_SCRIPTED_TASK,
  LAB_PHOTO_TASK,
  META_TRANSCRIBE_MODEL,
  ORDER_AGENT_SCRIPTED_TASK,
  ORDER_AGENT_TASK,
  scriptedOrderAgentResponder,
  type TranscriptionProvider,
  VOICE_TRANSCRIPTION_SCRIPTED_TASK,
  VOICE_TRANSCRIPTION_TASK,
  heuristicResponder,
  type LlmSnapshot,
  type LlmSnapshotEntry,
  META_DEFAULT_MODEL,
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_TASK,
  type NoteFixture,
  type PricingTable,
  scriptedAdjudicatorResponder,
  scriptedReviewerResponder,
  createRuleAuthoringAgent,
  FAKE_RULE_AUTHOR_MODEL,
  RULE_AUTHORING_TASK,
  scriptedRuleAuthorResponder,
  type SnapshotProvider,
  type StructuredLlmProvider,
} from '@follow-up-engine/llm';
import type { LlmConfig } from './config.ts';
import { extractDocumentText } from './documents.ts';
import {
  scriptedDocumentReadings,
  scriptedPhotoReadings,
  scriptedTranscripts,
} from './order-agent/samples.ts';

/** A document's text for the lab-result reading (PDF, DOCX, TXT); `undefined` when it has none. */
async function documentTextOf(
  document: Uint8Array,
  contentType: string,
): Promise<string | undefined> {
  const extracted = await extractDocumentText({
    filename: 'document',
    contentType,
    data: document,
  });
  return 'text' in extracted ? extracted.text : undefined;
}

/** Gateway task of the clinical reviewer on the scripted fake (the agent's scripted mode). */
export const SCRIPTED_CLINICAL_REVIEW_TASK = 'clinical_review_scripted';

/** Gateway task of the rule-authoring agent on the scripted fake (its scripted mode never spends). */
export const SCRIPTED_RULE_AUTHORING_TASK = 'rule_authoring_scripted';

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
  /** Translates a finding the reviewing model wrote in one language only. */
  readonly findingTranslator: FindingTranslator;
  /** Model the reviewer runs on (the scripted reviewer on the fake provider). */
  readonly reviewerModel: string;
  /** The adjudicator of ambiguous plan items, on the same gateway, provider and budget. */
  readonly adjudicator: ExpectationAdjudicator;
  /** Model the adjudicator runs on (the scripted adjudicator on the fake provider). */
  readonly adjudicatorModel: string;
  /** The recorded replies being replayed, when a snapshot of this provider was given. */
  readonly replay?: Pick<SnapshotProvider, 'stats' | 'snapshot'>;
  /** The order-to-completion agent's model loop (live and scripted modes). */
  readonly orderAgentModel: OrderAgentModel;
  /** Voice notes and lab report photos of the agent's patients. */
  readonly mediaReader: PatientMediaReader;
  /** The clinical reviewer on the scripted fake (the agent's scripted mode never spends). */
  readonly scriptedReviewAgent: ClinicalReviewAgent;
  /** Whether the agent's live mode runs a real model (anything but the fake provider). */
  readonly liveAgent: boolean;
  /** The rule-authoring agent (docs/agent/rule-authoring.md): the configured model, and the scripted fake. */
  readonly ruleAuthorAgents: {
    readonly live: RuleAuthoringAgent;
    readonly scripted: RuleAuthoringAgent;
  };
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
  /** The monthly budget of a clinic without one of its own (lab clinics: `DEMO_LLM_MONTHLY_BUDGET_USD`). */
  readonly fallbackBudgetUsd?: (clinicId: ClinicId) => number | undefined;
}

interface ProviderChoice {
  readonly provider: StructuredLlmProvider;
  readonly info: ExtractorInfo;
  readonly pricing: PricingTable;
  /** The reviewer's model when it differs from the extractor's (the fake's scripted reviewer). */
  readonly reviewerModel?: string;
  /** The adjudicator's model when it differs from the extractor's (the fake's scripted adjudicator). */
  readonly adjudicatorModel?: string;
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
          ...(config.metaBaseUrl === undefined ? {} : { baseUrl: config.metaBaseUrl }),
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
            scriptedOrderAgentResponder,
            createScriptedLabPhotoResponder(scriptedPhotoReadings()),
            createScriptedLabDocumentResponder(scriptedDocumentReadings()),
            scriptedReviewerResponder,
            scriptedRuleAuthorResponder,
            scriptedAdjudicatorResponder,
            createNoteFixtureResponder(deps.noteFixtures ?? []),
            heuristicResponder,
          ),
        }),
        info: { provider: 'fake', model: FAKE_DEFAULT_MODEL },
        pricing: DEFAULT_PRICING,
        reviewerModel: FAKE_REVIEWER_MODEL,
        adjudicatorModel: FAKE_ADJUDICATOR_MODEL,
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
          // The demo seed (and `demo:record`) replay recorded replies for
          // speed, not to reproduce spend: a replay costs the clinic nothing,
          // so it must not count against the monthly LLM budget or the
          // "cost of the month" the inbox shows (HIP regression: a $3 demo
          // budget was exhausted by replayed snapshot calls alone, pausing
          // the backfill before it released any case).
          replayUsage: 'none',
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
  // The agent's scripted mode always has the fake provider, whatever the live one is.
  const scripted =
    choice.info.provider === 'fake' ? choice : chooseProvider({ provider: 'fake' }, deps);
  const live = choice.info.provider;
  const isFake = live === 'fake';
  const transcribers: Record<string, TranscriptionProvider> = {
    fake: createFakeTranscriber(scriptedTranscripts()),
    ...(live === 'meta'
      ? {
          meta: createMetaTranscriber({
            apiKey: config.metaApiKey ?? '',
            ...(config.metaBaseUrl === undefined ? {} : { baseUrl: config.metaBaseUrl }),
            ...(deps.llmFetch === undefined ? {} : { fetch: deps.llmFetch }),
          }),
        }
      : {}),
  };
  const gateway = createLlmGateway({
    providers: {
      [choice.info.provider]: replay ?? choice.provider,
      ...(fallback === undefined ? {} : { [fallback.info.provider]: fallback.provider }),
      fake: fallback?.provider ?? scripted.provider,
    },
    transcribers,
    transcriptionTasks: {
      [VOICE_TRANSCRIPTION_TASK]:
        live === 'meta'
          ? { provider: 'meta', model: META_TRANSCRIBE_MODEL, timeoutMs: 60_000 }
          : { provider: 'fake', model: FAKE_TRANSCRIBER_MODEL },
      [VOICE_TRANSCRIPTION_SCRIPTED_TASK]: { provider: 'fake', model: FAKE_TRANSCRIBER_MODEL },
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
      [ADJUDICATION_TASK]: {
        route: [
          { provider: choice.info.provider, model: choice.adjudicatorModel ?? choice.info.model },
          ...(fallback === undefined
            ? []
            : [{ provider: fallback.info.provider, model: fallback.adjudicatorModel ?? '' }]),
        ],
        // Muse Spark bills its reasoning as output: room to think before a short answer.
        maxOutputTokens: 3_000,
      },
      [SCRIPTED_CLINICAL_REVIEW_TASK]: {
        route: [{ provider: 'fake', model: FAKE_REVIEWER_MODEL }],
      },
      // A finding the reviewing model wrote in one language only: its three texts, nothing else.
      [FINDING_TRANSLATION_TASK]: {
        route: [
          { provider: choice.info.provider, model: choice.reviewerModel ?? choice.info.model },
        ],
        maxOutputTokens: 2_000,
      },
      [RULE_AUTHORING_TASK]: {
        route: [{ provider: live, model: isFake ? FAKE_RULE_AUTHOR_MODEL : choice.info.model }],
        // Muse Spark bills its reasoning as output, and a draft is a long JSON.
        maxOutputTokens: 8_000,
        timeoutMs: 120_000,
      },
      [SCRIPTED_RULE_AUTHORING_TASK]: {
        route: [{ provider: 'fake', model: FAKE_RULE_AUTHOR_MODEL }],
      },
      [ORDER_AGENT_TASK]: {
        route: [{ provider: live, model: isFake ? FAKE_ORDER_AGENT_MODEL : choice.info.model }],
        maxOutputTokens: 3_000,
      },
      [ORDER_AGENT_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: FAKE_ORDER_AGENT_MODEL }] },
      [LAB_PHOTO_TASK]: {
        route: [{ provider: live, model: isFake ? FAKE_VISION_MODEL : choice.info.model }],
        maxOutputTokens: 4_000,
      },
      [LAB_PHOTO_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
      // A PDF report: its text, read by the same model into the same reading as a photo.
      [LAB_DOCUMENT_TASK]: {
        route: [{ provider: live, model: isFake ? FAKE_VISION_MODEL : choice.info.model }],
        maxOutputTokens: 4_000,
      },
      [LAB_DOCUMENT_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
    },
    usageLog: deps.usageLog,
    pricing: choice.pricing,
    monthlyBudgetUsd: async (clinicId) =>
      (await deps.clinics.get(clinicId))?.settings.llmMonthlyBudgetUsd ??
      deps.fallbackBudgetUsd?.(clinicId),
    // The one place every image passes: a photo leaves only for a clinic that allows it.
    allowsUnmaskedImages: async (clinicId) =>
      (await deps.clinics.get(clinicId))?.settings.allowUnmaskedImagesToProvider === true,
    clock: deps.clock,
  });
  return {
    extractor: createNoteExtractor({ gateway }),
    info: choice.info,
    reviewAgent: createReviewAgent({ gateway }),
    findingTranslator: createFindingTranslator({ gateway }),
    reviewerModel: choice.reviewerModel ?? choice.info.model,
    adjudicator: createAdjudicator({ gateway }),
    adjudicatorModel: choice.adjudicatorModel ?? choice.info.model,
    ...(replay === undefined ? {} : { replay }),
    orderAgentModel: createOrderAgentModel({ gateway }),
    mediaReader: createPatientMediaReader({ gateway, documentText: documentTextOf }),
    scriptedReviewAgent: createReviewAgent({ gateway, task: SCRIPTED_CLINICAL_REVIEW_TASK }),
    liveAgent: !isFake,
    ruleAuthorAgents: {
      live: createRuleAuthoringAgent({ gateway, maxOutputTokens: 8_000 }),
      scripted: createRuleAuthoringAgent({ gateway, task: SCRIPTED_RULE_AUTHORING_TASK }),
    },
  };
}
