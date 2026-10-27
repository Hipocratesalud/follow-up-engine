import type { ClinicId } from '../domain/ids.ts';
import type { AuditLog } from './audit-log.ts';
import type { BackfillProgressStore } from './backfill-progress.ts';
import type { CaseRepository } from './case-repository.ts';
import type {
  ClinicalFindingRepository,
  ClinicalReviewRunRepository,
  FindingFlagRepository,
} from './clinical-finding-repository.ts';
import type { ClinicalRecordRepository } from './clinical-record-repository.ts';
import type { ConditionRepository, QualityFindingRepository } from './condition-repository.ts';
import type { ExpectationRepository } from './expectation-repository.ts';
import type { FeedbackRepository } from './feedback-repository.ts';
import type { JobQueue, Outbox } from './job-queue.ts';

/** Every store, bound to one transaction. */
export interface TransactionalStores {
  readonly clinicalRecords: ClinicalRecordRepository;
  readonly expectations: ExpectationRepository;
  readonly cases: CaseRepository;
  readonly feedback: FeedbackRepository;
  readonly conditions: ConditionRepository;
  readonly qualityFindings: QualityFindingRepository;
  readonly audit: AuditLog;
  readonly jobs: JobQueue;
  readonly outbox: Outbox;
  readonly backfillProgress: BackfillProgressStore;
  readonly clinicalFindings: ClinicalFindingRepository;
  readonly reviewRuns: ClinicalReviewRunRepository;
  readonly findingFlags: FindingFlagRepository;
}

/**
 * Runs work atomically: every write made through `stores` (including jobs
 * and outbox events) commits together or not at all. The Postgres adapter
 * also scopes the transaction to `clinicId` (for row-level security).
 */
export interface UnitOfWork {
  withTransaction<TResult>(
    clinicId: ClinicId,
    work: (stores: TransactionalStores) => Promise<TResult>,
  ): Promise<TResult>;
}
