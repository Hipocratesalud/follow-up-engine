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
} from './extraction/prompt.ts';
export {
  EXTRACTION_OUTPUT_NAME,
  ModelExtractionSchema,
  type ModelExtraction,
} from './extraction/schema.ts';
export { LOINC_SYSTEM, isValidLoinc, postProcessExtraction } from './extraction/post-process.ts';
export { addInterval, resolveDueAt } from './extraction/due-date.ts';
export { locateQuote, normalizeForMatch } from './extraction/quote.ts';
export {
  ExpectedExtractionSchema,
  ExtractionFixtureSchema,
  chainResponders,
  createNoteFixtureResponder,
  modelOutputFromExpected,
  modelOutputFromExtraction,
  type ExpectedExtraction,
  type ExtractionFixture,
  type NoteFixture,
} from './extraction/fixtures.ts';
export { heuristicExtraction, heuristicResponder } from './extraction/heuristic-baseline.ts';
export type {
  DetailedNoteExtraction,
  ExtractedCondition,
  ExtractedMedication,
  NoteExtraction,
  NoteExtractionInput,
  NoteExtractor,
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
