/**
 * `@follow-up-engine/worker`: the engine runtime (composition root that
 * picks every adapter from the environment) and the background worker
 * (job runner, deadline and escalation sweeps, outbox delivery through
 * signed webhooks). `apps/api` runs on the same runtime; see
 * docs/adr/0005-http-api-and-runtime.md.
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
} from './runtime/runtime.ts';
export {
  CLINIC_CONTEXT_OWNER,
  INGEST_BUNDLE_JOB,
  IngestionService,
  type BundleAcceptance,
  type IngestMode,
  type StoredEntry,
} from './runtime/ingestion.ts';
export type { ExtractorInfo } from './runtime/llm.ts';
export { createLogger, type Logger } from './runtime/logger.ts';
export type { LlmUsageSummary, PatientRecord, ReadModel } from './runtime/read-model.ts';
export type { ClinicRegistration, DrainResult, Storage } from './runtime/storage.ts';
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
