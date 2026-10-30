import {
  createMemoryStores,
  MemoryClinicDirectory,
  MemoryDatabase,
  MemoryOrderAgentStore,
  MemoryLlmUsageLog,
  type MemoryStores,
  MemoryUnitOfWork,
} from '@follow-up-engine/adapter-memory';
import { SystemClock } from '@follow-up-engine/core';
import {
  describeAuditLogContract,
  describeBackfillProgressStoreContract,
  describeCaseRepositoryContract,
  describeContactRepositoryContract,
  describeClinicalFindingRepositoryContract,
  describeClinicalRecordRepositoryContract,
  describeClinicalReviewRunRepositoryContract,
  describeClinicDirectoryContract,
  describeConditionRepositoryContract,
  describeExpectationRepositoryContract,
  describeFeedbackRepositoryContract,
  describeFindingFlagRepositoryContract,
  describeJobQueueContract,
  describeLlmUsageLogContract,
  describeMetricsReadModelContract,
  describeOutboxContract,
  describePlanItemReviewLogContract,
  describeAdjudicationRepositoryContract,
  describeQualityFindingRepositoryContract,
  describeReconciliationStoreContract,
  describeRuleOverrideStoreContract,
  describeOrderAgentStoreContract,
  describeSuppressionRepositoryContract,
  describeUnitOfWorkContract,
} from '@follow-up-engine/testkit';

const NAME = 'adapter-memory';
const noop = (): Promise<void> => Promise.resolve();

function fresh(): MemoryStores {
  return createMemoryStores(new MemoryDatabase(), new SystemClock());
}

function store<TSubject>(pick: (stores: MemoryStores) => TSubject) {
  return () => Promise.resolve({ subject: pick(fresh()), cleanup: noop });
}

describeExpectationRepositoryContract(
  NAME,
  store((s) => s.expectations),
);
describeCaseRepositoryContract(
  NAME,
  store((s) => s.cases),
);
describeContactRepositoryContract(
  NAME,
  store((s) => s.contacts),
);
describeSuppressionRepositoryContract(
  NAME,
  store((s) => s.suppressions),
);
describeClinicalRecordRepositoryContract(
  NAME,
  store((s) => s.clinicalRecords),
);
describeFeedbackRepositoryContract(
  NAME,
  store((s) => s.feedback),
);
describeConditionRepositoryContract(
  NAME,
  store((s) => s.conditions),
);
describeQualityFindingRepositoryContract(
  NAME,
  store((s) => s.qualityFindings),
);
describeAuditLogContract(
  NAME,
  store((s) => s.audit),
);
describeJobQueueContract(
  NAME,
  store((s) => s.jobs),
);
describeBackfillProgressStoreContract(
  NAME,
  store((s) => s.backfillProgress),
);
describeRuleOverrideStoreContract(
  NAME,
  store((s) => s.ruleOverrides),
);
describeReconciliationStoreContract(
  NAME,
  store((s) => s.reconciliation),
);
describeClinicalFindingRepositoryContract(
  NAME,
  store((s) => s.clinicalFindings),
);
describeClinicalReviewRunRepositoryContract(
  NAME,
  store((s) => s.reviewRuns),
);
describeFindingFlagRepositoryContract(
  NAME,
  store((s) => s.findingFlags),
);
describePlanItemReviewLogContract(
  NAME,
  store((s) => s.planItemReviews),
);
describeAdjudicationRepositoryContract(
  NAME,
  store((s) => s.adjudications),
);

describeOutboxContract(NAME, () => {
  const { outbox } = fresh();
  return Promise.resolve({
    subject: outbox,
    pending: (clinic) => outbox.pending(clinic),
    cleanup: noop,
  });
});

describeUnitOfWorkContract(NAME, () => {
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, new SystemClock());
  return Promise.resolve({
    subject: new MemoryUnitOfWork(db, stores),
    pendingOutbox: (clinic) => stores.outbox.pending(clinic),
    cleanup: noop,
  });
});

describeClinicDirectoryContract(NAME, (seed) =>
  Promise.resolve({
    subject: new MemoryClinicDirectory(
      seed.map(({ clinic, apiKeyHash }) => ({ clinic, apiKeyHash })),
    ),
    cleanup: noop,
  }),
);

describeLlmUsageLogContract(NAME, () =>
  Promise.resolve({ subject: new MemoryLlmUsageLog(new MemoryDatabase()), cleanup: noop }),
);

describeMetricsReadModelContract(NAME, () => {
  const db = new MemoryDatabase();
  return Promise.resolve({
    subject: {
      stores: createMemoryStores(db, new SystemClock()),
      llmUsage: new MemoryLlmUsageLog(db),
    },
    cleanup: noop,
  });
});
describeOrderAgentStoreContract(NAME, () =>
  Promise.resolve({ subject: new MemoryOrderAgentStore(), cleanup: noop }),
);
