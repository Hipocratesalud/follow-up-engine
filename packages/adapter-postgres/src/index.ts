/**
 * `@follow-up-engine/adapter-postgres`: every storage-like port of the core
 * on Postgres 15+ (vanilla or Supabase), plus the job queue and the
 * transactional outbox (ADR 0003). See docs/deploy.md.
 *
 * ```ts
 * const pool = createPool();                 // DATABASE_URL
 * await migrate(pool);                       // schema `follow_up`
 * const adapters = createPostgresAdapters(pool, { clock });
 * await adapters.unitOfWork.withTransaction(clinicId, async (stores) => { ... });
 * ```
 */

export const PACKAGE_NAME = '@follow-up-engine/adapter-postgres';

export {
  createPool,
  createPostgresAdapters,
  MissingDatabaseUrlError,
  type CreatePoolOptions,
  type PostgresAdapters,
  type PostgresAdaptersOptions,
} from './adapters.ts';
export {
  loadMigrations,
  migrate,
  MigrationChecksumError,
  type Migration,
  type MigrateOptions,
  type MigrateResult,
} from './migrate.ts';
export { applySupabaseRowLevelSecurity } from './supabase.ts';
export { DEFAULT_SCHEMA, InvalidSchemaNameError, type Queryable } from './sql.ts';
export { CorruptRowError } from './codec.ts';
export type { PostgresStores } from './stores.ts';
export {
  PostgresUnitOfWork,
  TransactionAbortedError,
  TransactionClosedError,
} from './unit-of-work.ts';

export { PostgresClinicalRecordRepository } from './clinical-record-repository.ts';
export { PostgresExpectationRepository } from './expectation-repository.ts';
export { InvalidCursorError, PostgresCaseRepository } from './case-repository.ts';
export { PostgresAuditLog, PostgresFeedbackRepository } from './case-records.ts';
export {
  PostgresConditionRepository,
  PostgresQualityFindingRepository,
} from './condition-repository.ts';
export {
  DEFAULT_CLINIC_SETTINGS,
  hashApiKey,
  PostgresClinicDirectory,
  type ClinicRegistration,
} from './clinic-directory.ts';
export { PostgresLlmUsageLog } from './llm-usage-log.ts';
export { PostgresMetricsReadModel } from './metrics-read-model.ts';
export { PostgresPlanItemReviewLog } from './plan-item-review-log.ts';
export {
  PostgresClinicalFindingRepository,
  PostgresClinicalReviewRunRepository,
  PostgresFindingFlagRepository,
} from './clinical-finding-repositories.ts';
export { PostgresBackfillProgressStore } from './backfill-progress-store.ts';
export { PostgresReconciliationStore } from './reconciliation-store.ts';
export { PostgresRuleOverrideStore } from './rule-override-store.ts';
export { PostgresContactRepository, PostgresSuppressionRepository } from './contact-repository.ts';
export {
  DEFAULT_JOB_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  PostgresJobQueue,
  type JobSnapshot,
  type JobStatus,
} from './job-queue.ts';
export {
  DEFAULT_OUTBOX_BACKOFF,
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  PostgresOutbox,
  PostgresOutboxRelay,
  type DrainOutboxOptions,
  type DrainOutboxResult,
} from './outbox.ts';
