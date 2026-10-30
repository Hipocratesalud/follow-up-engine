import type { ClinicId } from '../domain/ids.ts';
import type { AdjudicationRepository } from './adjudication-repository.ts';
import type { AuditLog } from './audit-log.ts';
import type { BackfillProgressStore } from './backfill-progress.ts';
import type { CaseRepository } from './case-repository.ts';
import type { MetricsReadModel } from './metrics-read-model.ts';
import type {
  ClinicalFindingRepository,
  ClinicalReviewRunRepository,
  FindingFlagRepository,
} from './clinical-finding-repository.ts';
import type { ClinicalRecordRepository } from './clinical-record-repository.ts';
import type { ConditionRepository, QualityFindingRepository } from './condition-repository.ts';
import type { ContactRepository } from './contact-repository.ts';
import type { ExpectationEventLog } from './expectation-event-log.ts';
import type { ExpectationRepository } from './expectation-repository.ts';
import type { FeedbackRepository } from './feedback-repository.ts';
import type { JobQueue, Outbox } from './job-queue.ts';
import type { PlanItemReviewLog } from './plan-item-review-log.ts';
import type { ReconciliationStore } from './reconciliation-store.ts';
import type { RuleOverrideStore } from './rule-override-store.ts';
import type { SuppressionRepository } from './suppression-repository.ts';

/** Every store, bound to one transaction. */
export interface TransactionalStores {
  readonly clinicalRecords: ClinicalRecordRepository;
  readonly expectations: ExpectationRepository;
  /** Append-only audit of expectations outside a case (a reclassified closure). */
  readonly expectationEvents: ExpectationEventLog;
  readonly cases: CaseRepository;
  readonly feedback: FeedbackRepository;
  readonly conditions: ConditionRepository;
  readonly qualityFindings: QualityFindingRepository;
  readonly audit: AuditLog;
  readonly jobs: JobQueue;
  readonly outbox: Outbox;
  readonly backfillProgress: BackfillProgressStore;
  readonly contacts: ContactRepository;
  readonly suppressions: SuppressionRepository;
  readonly clinicalFindings: ClinicalFindingRepository;
  readonly reviewRuns: ClinicalReviewRunRepository;
  readonly findingFlags: FindingFlagRepository;
  /** Read side of the clinic metrics (HIP-141). */
  readonly metrics: MetricsReadModel;
  readonly planItemReviews: PlanItemReviewLog;
  readonly ruleOverrides: RuleOverrideStore;
  readonly reconciliation: ReconciliationStore;
  /** The adjudicator's decisions on ambiguous plan items (PRD V2). */
  readonly adjudications: AdjudicationRepository;
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
