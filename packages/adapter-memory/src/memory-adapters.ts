import {
  type Clinic,
  type ClinicId,
  type Clock,
  type FollowUpEngine,
  type EngineSettings,
  type EscalationPolicySource,
  type ProtocolSource,
  type RuleSource,
  type TransactionalStores,
  createFollowUpEngine,
} from '@follow-up-engine/core';
import {
  DEFAULT_CLINIC_SETTINGS,
  MemoryClinicDirectory,
  MemoryLlmUsageLog,
} from './clinic-directory.ts';
import {
  FileEscalationPolicySource,
  FileProtocolSource,
  FileRuleSource,
} from './config-sources.ts';
import { FakeNoteExtractor } from './fake-note-extractor.ts';
import { SequentialIdGenerator } from './id-generator.ts';
import { MemoryJobQueue, MemoryOutbox } from './job-queue.ts';
import { MemoryDatabase } from './memory-database.ts';
import { MemoryMetricsReadModel } from './repositories/metrics-read-model.ts';
import { MemoryBackfillProgressStore } from './repositories/backfill-progress-store.ts';
import { MemoryCaseRepository } from './repositories/case-repository.ts';
import {
  MemoryClinicalFindingRepository,
  MemoryClinicalReviewRunRepository,
  MemoryFindingFlagRepository,
} from './repositories/clinical-finding-repositories.ts';
import { MemoryClinicalRecordRepository } from './repositories/clinical-record-repository.ts';
import {
  MemoryContactRepository,
  MemorySuppressionRepository,
} from './repositories/contact-repository.ts';
import { MemoryExpectationRepository } from './repositories/expectation-repository.ts';
import {
  MemoryAuditLog,
  MemoryConditionRepository,
  MemoryFeedbackRepository,
  MemoryQualityFindingRepository,
} from './repositories/other-repositories.ts';
import { MemoryUnitOfWork } from './unit-of-work.ts';

/** Every memory store, sharing one {@link MemoryDatabase}. */
export interface MemoryStores extends TransactionalStores {
  readonly expectations: MemoryExpectationRepository;
  readonly cases: MemoryCaseRepository;
  readonly audit: MemoryAuditLog;
  readonly jobs: MemoryJobQueue;
  readonly outbox: MemoryOutbox;
  readonly backfillProgress: MemoryBackfillProgressStore;
  readonly contacts: MemoryContactRepository;
  readonly suppressions: MemorySuppressionRepository;
  readonly clinicalFindings: MemoryClinicalFindingRepository;
  readonly reviewRuns: MemoryClinicalReviewRunRepository;
  readonly findingFlags: MemoryFindingFlagRepository;
}

/** Builds every memory store over one database. */
export function createMemoryStores(db: MemoryDatabase, clock: Clock): MemoryStores {
  return {
    clinicalRecords: new MemoryClinicalRecordRepository(db),
    expectations: new MemoryExpectationRepository(db),
    cases: new MemoryCaseRepository(db),
    feedback: new MemoryFeedbackRepository(db),
    conditions: new MemoryConditionRepository(db),
    qualityFindings: new MemoryQualityFindingRepository(db),
    audit: new MemoryAuditLog(db),
    jobs: new MemoryJobQueue(db, clock),
    outbox: new MemoryOutbox(db),
    backfillProgress: new MemoryBackfillProgressStore(db),
    contacts: new MemoryContactRepository(db),
    suppressions: new MemorySuppressionRepository(db),
    clinicalFindings: new MemoryClinicalFindingRepository(db),
    reviewRuns: new MemoryClinicalReviewRunRepository(db),
    findingFlags: new MemoryFindingFlagRepository(db),
    metrics: new MemoryMetricsReadModel(db),
  };
}

export interface MemoryEngineOptions {
  readonly clock: Clock;
  /** Clinics to register; a demo clinic `clinic-demo` when absent. */
  readonly clinics?: readonly Clinic[];
  readonly rules?: RuleSource;
  readonly protocols?: ProtocolSource;
  readonly escalationPolicies?: EscalationPolicySource;
  readonly extractor?: FakeNoteExtractor;
  readonly settings?: Partial<EngineSettings>;
}

/** The engine running entirely in memory, with handles on every adapter. */
export interface MemoryEngine {
  readonly engine: FollowUpEngine;
  readonly db: MemoryDatabase;
  readonly stores: MemoryStores;
  readonly unitOfWork: MemoryUnitOfWork;
  readonly clinics: MemoryClinicDirectory;
  readonly llmUsage: MemoryLlmUsageLog;
  readonly extractor: FakeNoteExtractor;
  readonly ids: SequentialIdGenerator;
}

/** A clinic with PRD default settings. */
export function demoClinic(id: ClinicId, overrides: Partial<Clinic['settings']> = {}): Clinic {
  return {
    id,
    name: `Clinic ${id}`,
    active: true,
    settings: { ...DEFAULT_CLINIC_SETTINGS, ...overrides },
  };
}

/**
 * Wires the whole engine over memory adapters and the repository's
 * `config/` rules and protocols: the composition used by tests, evals and
 * the offline demo.
 */
export function createMemoryEngine(options: MemoryEngineOptions): MemoryEngine {
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, options.clock);
  const unitOfWork = new MemoryUnitOfWork(db, stores);
  const clinics = new MemoryClinicDirectory(
    (options.clinics ?? [demoClinic('clinic-demo' as ClinicId)]).map((clinic) => ({ clinic })),
  );
  const extractor = options.extractor ?? new FakeNoteExtractor();
  const ids = new SequentialIdGenerator();
  const engine = createFollowUpEngine({
    unitOfWork,
    noteExtractor: extractor,
    rules: options.rules ?? new FileRuleSource(),
    protocols: options.protocols ?? new FileProtocolSource(),
    escalationPolicies: options.escalationPolicies ?? new FileEscalationPolicySource(),
    clinics,
    clock: options.clock,
    ids,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  return {
    engine,
    db,
    stores,
    unitOfWork,
    clinics,
    llmUsage: new MemoryLlmUsageLog(db),
    extractor,
    ids,
  };
}
