/**
 * `@follow-up-engine/runtime`: the engine runtime shared by every process.
 * The composition root that picks every adapter from the environment
 * (`createRuntime`), the ingestion service, the background worker loops (job
 * runner, deadline and escalation sweeps, outbox delivery) and the signed
 * webhook publisher. `apps/api` and `apps/worker` are thin process entry
 * points over it; see docs/adr/0005-http-api-and-runtime.md.
 */
export {
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
  DEFAULT_FAKE_CLOCK_START,
  defined,
  PUBLIC_DEMO_KEYS,
  DEV_WEBHOOK_SECRET,
  InvalidConfigError,
  LLM_PROVIDERS,
  loadRuntimeConfig,
  type LlmConfig,
  type LlmProviderName,
  type RuntimeConfig,
  type WebhookConfig,
} from './config.ts';
export {
  activeClinicIds,
  createRuntime,
  DEMO_CLINIC,
  DEMO_DAILY_CASE_CAP_PER_OWNER,
  DEMO_ADJUDICATOR_SETTINGS,
  DEMO_ESCALATION_POLICY,
  availableProtocolIds,
  DEMO_INBOX_KEY_LABEL,
  ensureLabClinic,
  isLabClinicId,
  reviewLocaleOf,
  LAB_CLINIC_PREFIX,
  labClinicId,
  registerDemoClinic,
  ruleConfigOf,
  type CreateRuntimeOptions,
  type EngineRuntime,
  type IssuedApiKey,
  type Principal,
} from './runtime.ts';
export {
  API_KEY_SCOPES,
  ApiKeyConflictError,
  DEMO_SCOPES,
  generateApiKey,
  hashApiKey,
  ADMIN_SCOPES,
  INBOX_SCOPES,
  INTEGRATION_SCOPES,
  isApiKeyScope,
  isDemoScope,
  type ApiKeyRecord,
  type ApiKeyScope,
  type ApiKeyStore,
} from './api-keys.ts';
export {
  CLINIC_CONTEXT_OWNER,
  INGEST_BUNDLE_JOB,
  IngestionService,
  type BundleAcceptance,
  type EntryResult,
  type HistoryStaging,
  type IngestMode,
  type StoredEntry,
} from './ingestion.ts';
export {
  EVALUATOR_ACTIONS,
  isEvaluatorAction,
  MemoryEvaluatorEventStore,
  PostgresEvaluatorEventStore,
  type EvaluatorAction,
  type EvaluatorEvent,
  type EvaluatorEventPage,
  type EvaluatorEventQuery,
  type EvaluatorEventStore,
  type EvaluatorSummary,
  type NewEvaluatorEvent,
} from './evaluator-events.ts';
export {
  ensureLabClinicAndClock,
  InvalidLabDateError,
  labIngestion,
  LabClockRegistry,
  setLabClinicDate,
  type LabClockAdvance,
} from './lab.ts';
export type { ExtractorInfo, LlmSnapshotOption } from './llm.ts';
export {
  MARIA,
  ORDER_AGENT_STORIES,
  startOrderAgentStory,
  type OrderAgentStory,
} from './order-agent/story.ts';
export {
  readSample,
  SAMPLE_FILES,
  SAMPLE_LAB_READING,
  SAMPLE_TRANSCRIPTS,
  type SampleName,
} from './order-agent/samples.ts';
/** Gateway task names, for per-task LLM usage (notes read vs clinical reviews). */
export { CLINICAL_REVIEW_TASK, NOTE_EXTRACTION_TASK } from '@follow-up-engine/llm';
export { createLogger, type Logger } from './logger.ts';
export { patientRedactTerms, withPatientRedaction } from './redaction.ts';
export type { JobView, PatientRecord, ReadModel } from './read-model.ts';
export type { ClinicRegistration, DrainResult, Storage } from './storage.ts';
export {
  ClockNotFakeError,
  jobRetryDelayMs,
  Worker,
  WORKER_JOB_TYPES,
  type ClockAdvance,
  type JobPassResult,
  type SweepResult,
  type WorkerOptions,
} from './worker.ts';
export { toWebhookBody, type WebhookBody } from './webhooks/payload.ts';
export {
  buildSignedWebhook,
  createWebhookPublisher,
  WebhookDeliveryError,
  type SignedWebhook,
  type WebhookPublisherOptions,
} from './webhooks/publisher.ts';
export {
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_HEADERS,
  WEBHOOK_TOLERANCE_SECONDS,
  type SignedParts,
} from './webhooks/signature.ts';
export {
  createLoopbackPublisher,
  createWebhookSinkApp,
  WEBHOOK_SINK_PATH,
  WebhookSink,
  type SinkDelivery,
  type WebhookSinkOptions,
} from './webhooks/sink.ts';
export {
  createSimulatedEngine,
  createSimulationReportCache,
  DEFAULT_SIMULATION_CONFIG_URL,
  loadSimulationConfig,
  runOutcomeSimulation,
  SIMULATION_CLINIC_ID,
  SIMULATION_LIMITS,
  SIMULATION_SNAPSHOT_URL,
  type OutcomeSimulationOptions,
  type SimulationReportCache,
  type SimulationReportState,
} from './simulation.ts';
