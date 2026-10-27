/**
 * `@follow-up-engine/runtime`: the engine runtime shared by every process.
 * The composition root that picks every adapter from the environment
 * (`createRuntime`), the ingestion service, the background worker loops (job
 * runner, deadline and escalation sweeps, outbox delivery) and the signed
 * webhook publisher. `apps/api` and `apps/worker` are thin process entry
 * points over it; see docs/adr/0005-http-api-and-runtime.md.
 */
export {
  DEFAULT_FAKE_CLOCK_START,
  defined,
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
  hashApiKey,
  registerDemoClinic,
  type CreateRuntimeOptions,
  type EngineRuntime,
} from './runtime.ts';
export {
  CLINIC_CONTEXT_OWNER,
  INGEST_BUNDLE_JOB,
  IngestionService,
  type BundleAcceptance,
  type HistoryStaging,
  type IngestMode,
  type StoredEntry,
} from './ingestion.ts';
export type { ExtractorInfo } from './llm.ts';
export { createLogger, type Logger } from './logger.ts';
export type { PatientRecord, ReadModel } from './read-model.ts';
export type { ClinicRegistration, DrainResult, Storage } from './storage.ts';
export {
  jobRetryDelayMs,
  Worker,
  WORKER_JOB_TYPES,
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
export { signWebhookBody, verifyWebhookSignature, WEBHOOK_HEADERS } from './webhooks/signature.ts';
export {
  createLoopbackPublisher,
  createWebhookSinkApp,
  WEBHOOK_SINK_PATH,
  WebhookSink,
  type SinkDelivery,
  type WebhookSinkOptions,
} from './webhooks/sink.ts';
