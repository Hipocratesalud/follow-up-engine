/**
 * `@follow-up-engine/adapter-memory`: in-memory implementations of every core
 * port, for tests, evals and the offline demo. Faithful to the Postgres
 * adapters (same contract suites), including transaction rollback and job
 * leases.
 */
export const PACKAGE_NAME = '@follow-up-engine/adapter-memory';

export { MemoryDatabase, tenantKey } from './memory-database.ts';
export type { JobRecord, JobStatus, MemoryState, OutboxRecord } from './memory-database.ts';
export { MemoryClinicalRecordRepository } from './repositories/clinical-record-repository.ts';
export { MemoryExpectationRepository } from './repositories/expectation-repository.ts';
export { MemoryCaseRepository } from './repositories/case-repository.ts';
export { MemoryOrderAgentStore } from './repositories/order-agent-store.ts';
export { MemoryPlanItemReviewLog } from './repositories/plan-item-review-log.ts';
export { MemoryExpectationEventLog } from './repositories/expectation-event-log.ts';
export { MemoryAdjudicationRepository } from './repositories/adjudication-repository.ts';
export {
  MemoryClinicalFindingRepository,
  MemoryClinicalReviewRunRepository,
  MemoryFindingFlagRepository,
} from './repositories/clinical-finding-repositories.ts';
export { MemoryBackfillProgressStore } from './repositories/backfill-progress-store.ts';
export { MemoryMetricsReadModel } from './repositories/metrics-read-model.ts';
export { MemoryReconciliationStore } from './repositories/reconciliation-store.ts';
export { MemoryRuleOverrideStore } from './repositories/rule-override-store.ts';
export {
  MemoryContactRepository,
  MemorySuppressionRepository,
} from './repositories/contact-repository.ts';
export {
  MemoryAuditLog,
  MemoryConditionRepository,
  MemoryFeedbackRepository,
  MemoryQualityFindingRepository,
} from './repositories/other-repositories.ts';
export { MemoryEventPublisher, MemoryJobQueue, MemoryOutbox } from './job-queue.ts';
export { MemoryUnitOfWork } from './unit-of-work.ts';
export {
  DEFAULT_CLINIC_SETTINGS,
  MemoryClinicDirectory,
  MemoryLlmUsageLog,
} from './clinic-directory.ts';
export {
  DEFAULT_CONFIG_DIR,
  FileEscalationPolicySource,
  FileProtocolSource,
  FileRuleSource,
  loadConfigDirectory,
  StaticEscalationPolicySource,
  StaticProtocolSource,
  StaticRuleSource,
  type LoadedConfig,
  type RuleSourceOptions,
  type SourceOptions,
} from './config-sources.ts';
export { SequentialIdGenerator, UuidIdGenerator } from './id-generator.ts';
export {
  type CannedExtraction,
  FakeExtractionError,
  FakeNoteExtractor,
  type FakeNoteExtractorOptions,
} from './fake-note-extractor.ts';
export {
  createMemoryEngine,
  createMemoryStores,
  demoClinic,
  type MemoryEngine,
  type MemoryEngineOptions,
  type MemoryStores,
} from './memory-adapters.ts';
