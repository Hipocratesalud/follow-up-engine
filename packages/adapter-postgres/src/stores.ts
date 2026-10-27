import type { Clock, TransactionalStores } from '@follow-up-engine/core';
import { PostgresBackfillProgressStore } from './backfill-progress-store.ts';
import { PostgresAuditLog, PostgresFeedbackRepository } from './case-records.ts';
import { PostgresCaseRepository } from './case-repository.ts';
import { PostgresClinicDirectory } from './clinic-directory.ts';
import {
  PostgresClinicalFindingRepository,
  PostgresClinicalReviewRunRepository,
  PostgresFindingFlagRepository,
} from './clinical-finding-repositories.ts';
import { PostgresClinicalRecordRepository } from './clinical-record-repository.ts';
import { PostgresContactRepository, PostgresSuppressionRepository } from './contact-repository.ts';
import {
  PostgresConditionRepository,
  PostgresQualityFindingRepository,
} from './condition-repository.ts';
import { PostgresExpectationRepository } from './expectation-repository.ts';
import { PostgresJobQueue } from './job-queue.ts';
import { PostgresLlmUsageLog } from './llm-usage-log.ts';
import { PostgresMetricsReadModel } from './metrics-read-model.ts';
import { PostgresOutbox } from './outbox.ts';
import type { Queryable, Tables } from './sql.ts';

/** Every Postgres store: the `TransactionalStores` of the port plus the registry, LLM accounting and backfill progress. */
export interface PostgresStores extends TransactionalStores {
  readonly clinicalRecords: PostgresClinicalRecordRepository;
  readonly expectations: PostgresExpectationRepository;
  readonly cases: PostgresCaseRepository;
  readonly feedback: PostgresFeedbackRepository;
  readonly conditions: PostgresConditionRepository;
  readonly qualityFindings: PostgresQualityFindingRepository;
  readonly audit: PostgresAuditLog;
  readonly jobs: PostgresJobQueue;
  readonly outbox: PostgresOutbox;
  readonly clinics: PostgresClinicDirectory;
  readonly llmUsage: PostgresLlmUsageLog;
  readonly backfillProgress: PostgresBackfillProgressStore;
  readonly contacts: PostgresContactRepository;
  readonly suppressions: PostgresSuppressionRepository;
  readonly clinicalFindings: PostgresClinicalFindingRepository;
  readonly reviewRuns: PostgresClinicalReviewRunRepository;
  readonly findingFlags: PostgresFindingFlagRepository;
  readonly metrics: PostgresMetricsReadModel;
}

export function bindStores(db: () => Queryable, tables: Tables, clock: Clock): PostgresStores {
  const ctx = { db, tables, clock };
  return {
    clinicalRecords: new PostgresClinicalRecordRepository(ctx),
    expectations: new PostgresExpectationRepository(ctx),
    cases: new PostgresCaseRepository(ctx),
    feedback: new PostgresFeedbackRepository(ctx),
    conditions: new PostgresConditionRepository(ctx),
    qualityFindings: new PostgresQualityFindingRepository(ctx),
    audit: new PostgresAuditLog(ctx),
    jobs: new PostgresJobQueue(ctx),
    outbox: new PostgresOutbox(ctx),
    clinics: new PostgresClinicDirectory(ctx),
    llmUsage: new PostgresLlmUsageLog(ctx),
    backfillProgress: new PostgresBackfillProgressStore(ctx),
    contacts: new PostgresContactRepository(ctx),
    suppressions: new PostgresSuppressionRepository(ctx),
    clinicalFindings: new PostgresClinicalFindingRepository(ctx),
    reviewRuns: new PostgresClinicalReviewRunRepository(ctx),
    findingFlags: new PostgresFindingFlagRepository(ctx),
    metrics: new PostgresMetricsReadModel(ctx),
  };
}
