/**
 * `@follow-up-engine/llm`: the `llm_gateway` and its providers (Meta Model
 * API, Baseten / any OpenAI-compatible endpoint, deterministic fake), plus
 * the note extractor built on top of it and the extraction eval harness.
 */
export const PACKAGE_NAME = '@follow-up-engine/llm';

// Errors
export {
  LlmConfigError,
  LlmProviderError,
  LlmSchemaError,
  LlmTimeoutError,
  LlmUnavailableError,
  describeError,
} from './errors.ts';

// Shared types
export type { DetailedUsage, ProviderCompletion, ProviderRequest } from './usage.ts';
export { InMemoryLlmUsageLog, type LlmCallRecord, type LlmUsageLog } from './usage-log.ts';
export { isStrictCompatible, toJsonSchema, type JsonSchema } from './json-schema.ts';
export {
  DEFAULT_PRICING,
  costOf,
  priceFor,
  type ModelPrice,
  type PricingTable,
} from './pricing.ts';

// Providers
export {
  STRUCTURED_OUTPUT_MODES,
  createChatCompletionsProvider,
  type ChatCompletionsProviderOptions,
  type FetchLike,
  type StructuredLlmProvider,
  type StructuredOutputMode,
} from './providers/chat-completions.ts';
export {
  extractJsonText,
  issueSummary,
  parseStructuredOutput,
} from './providers/structured-output.ts';
export {
  META_API_BASE_URL,
  META_DEFAULT_MODEL,
  createMetaProvider,
  isContributorModel,
  type MetaProviderOptions,
  type MetaReasoningEffort,
} from './providers/meta.ts';
export {
  BASETEN_BASE_URL,
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  createBasetenProvider,
  createOpenAiCompatibleProvider,
  type BasetenProviderOptions,
  type OpenAiCompatibleProviderOptions,
} from './providers/openai-compatible.ts';
export {
  FAKE_DEFAULT_MODEL,
  FAKE_PROVIDER_NAME,
  createFakeProvider,
  fakeRequestKey,
  type FakeProviderOptions,
  type FakeResponder,
} from './providers/fake.ts';

export {
  createSnapshotProvider,
  emptySnapshot,
  mergeSnapshots,
  parseSnapshot,
  serializeSnapshot,
  snapshotKey,
  type LlmSnapshot,
  type LlmSnapshotEntry,
  type SnapshotProvider,
  type SnapshotProviderOptions,
} from './providers/snapshot.ts';

// Gateway
export {
  createLlmGateway,
  repairInstruction,
  startOfUtcMonth,
  type FollowUpLlmGateway,
  type GatewayResult,
  type LlmGatewayConfig,
  type RouteTarget,
  type TaskConfig,
} from './gateway/gateway.ts';
export { DEFAULT_RETRY_POLICY, backoffDelayMs, type RetryPolicy } from './gateway/retry.ts';

// Note extraction
export {
  createNoteExtractor,
  type DetailedNoteExtractor,
  type NoteExtractorOptions,
} from './extraction/note-extractor.ts';
export {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_SYSTEM_PROMPT,
  NOTE_EXTRACTION_TASK,
  buildExtractionMessages,
  sanitizeSpecialty,
} from './extraction/prompt.ts';
export {
  MAX_NOTE_CHARS,
  REDACTION_PLACEHOLDER,
  prepareNote,
  type PreparedNote,
} from './extraction/prepare.ts';
export {
  DEFAULT_CONDITION_TERMS,
  ENGLISH_CONDITION_TERMS,
  conditionTermsFor,
  type ConditionTermTable,
} from './extraction/condition-terms.ts';
export {
  DETECTABLE_NOTE_LANGUAGES,
  LEXICON_LANGUAGES,
  detectNoteLanguage,
  lexiconLanguage,
  resolveNoteLanguage,
  type DetectedNoteLanguage,
  type LexiconLanguage,
} from './extraction/language.ts';
export {
  EXTRACTION_OUTPUT_NAME,
  ModelExtractionSchema,
  ModelPregnancySchema,
  PREGNANCY_OUTCOME_KINDS,
  type ModelExtraction,
  type ModelPregnancy,
} from './extraction/schema.ts';
export {
  MAX_GESTATIONAL_WEEKS,
  MAX_OUTCOME_AGE_DAYS,
  postProcessPregnancy,
} from './extraction/pregnancy.ts';
export {
  LOINC_SYSTEM,
  MAX_ITEM_CONFIDENCE,
  isValidLoinc,
  postProcessExtraction,
  type PostProcessNote,
  type PostProcessOptions,
} from './extraction/post-process.ts';
export { addInterval, resolveDueAt } from './extraction/due-date.ts';
export { createQuoteIndex, locateQuote, normalizeForMatch } from './extraction/quote.ts';
export {
  ExpectedExtractionSchema,
  ExpectedPregnancySchema,
  ExtractionFixtureSchema,
  chainResponders,
  createNoteFixtureResponder,
  modelOutputFromExpected,
  modelOutputFromExtraction,
  type ExpectedExtraction,
  type ExpectedPregnancy,
  type ExtractionFixture,
  type NoteFixture,
} from './extraction/fixtures.ts';
export { heuristicExtraction, heuristicResponder } from './extraction/heuristic-baseline.ts';
export type {
  DetailedNoteExtraction,
  ExtractedCondition,
  ExtractedMedication,
  ExtractedPregnancy,
  ExtractionWarning,
  NoteExtraction,
  NoteExtractionInput,
  NoteExtractor,
  PregnancyOutcomeKind,
  RejectedItem,
  RejectionReason,
} from './extraction/types.ts';

// Eval harness (the CLI lives in src/eval/cli.ts)
export { GoldNoteSchema, goldAuthoredAt, loadGoldNotes, type GoldNote } from './eval/gold.ts';
export {
  compareExtraction,
  dueDaysMatch,
  icd10Category,
  matchCounts,
  medicationsMatch,
  percentile,
  pregnancyDatingCounts,
  pregnancyOutcomeCounts,
  scores,
  type Counts,
  type Scores,
} from './eval/metrics.ts';
export {
  aggregate,
  runExtractionEval,
  summarize,
  type EvalRun,
  type EvalSummary,
  type NoteResult,
  type RunEvalOptions,
} from './eval/run.ts';
export { renderReport, reportFileName } from './eval/report.ts';

// Clinical reviewer agent (PRD V3)
export { createReviewAgent, quoteFromOriginal, type ReviewAgentOptions } from './reviewer/agent.ts';
export {
  CLINICAL_REVIEW_PROMPT_VERSION,
  CLINICAL_REVIEW_TASK,
  inertJson,
  maskStrings,
  REVIEWER_ACTION_NAME,
  ReviewerActionSchema,
  reviewerSystemPrompt,
  type ReviewerAction,
} from './reviewer/prompt.ts';
export { FAKE_REVIEWER_MODEL, scriptedReviewerResponder } from './reviewer/scripted.ts';

// Adjudicator of ambiguous plan items (PRD V2, workstream E)
export {
  calibrateProbability,
  createAdjudicator,
  PROBABILITY_SHRINK,
  type AdjudicatorOptions,
} from './adjudicator/agent.ts';
export {
  ADJUDICATION_OUTPUT_NAME,
  ADJUDICATION_PROMPT_VERSION,
  ADJUDICATION_TASK,
  AdjudicationOutputSchema,
  adjudicationMessages,
  adjudicatorSystemPrompt,
  type AdjudicationOutput,
} from './adjudicator/prompt.ts';
export {
  FAKE_ADJUDICATOR_MODEL,
  scriptedAdjudication,
  scriptedAdjudicatorResponder,
} from './adjudicator/scripted.ts';

// Speech to text (Muse Voice Transcribe), a gateway capability
export {
  createFakeTranscriber,
  createMetaTranscriber,
  META_TRANSCRIBE_MODEL,
  sha256Hex,
  type MetaTranscriberOptions,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './providers/transcription.ts';
export type {
  TranscriptionGatewayRequest,
  TranscriptionGatewayResult,
  TranscriptionTaskConfig,
} from './gateway/gateway.ts';

// Order-to-completion agent (docs/agent/order-to-completion.md)
export { createOrderAgentModel, type OrderAgentModelOptions } from './agent/order-agent.ts';
export {
  ORDER_AGENT_ACTION_NAME,
  ORDER_AGENT_PROMPT_VERSION,
  ORDER_AGENT_SCRIPTED_TASK,
  ORDER_AGENT_TASK,
  OrderAgentActionSchema,
  orderAgentSystemPrompt,
  type OrderAgentAction,
} from './agent/prompt.ts';
export { FAKE_ORDER_AGENT_MODEL, scriptedOrderAgentResponder } from './agent/scripted.ts';
export {
  createPatientMediaReader,
  createScriptedLabPhotoResponder,
  FAKE_TRANSCRIBER_MODEL,
  FAKE_VISION_MODEL,
  LAB_PHOTO_OUTPUT_NAME,
  LAB_PHOTO_PROMPT_VERSION,
  LAB_PHOTO_SCRIPTED_TASK,
  LAB_PHOTO_TASK,
  LabPhotoReadingSchema,
  labPhotoMessages,
  toLabPhotoReading,
  VOICE_TRANSCRIPTION_SCRIPTED_TASK,
  VOICE_TRANSCRIPTION_TASK,
  type ModelLabPhotoReading,
} from './agent/media.ts';
export { outboundSafetyTerms } from './agent/outbound-terms.ts';
