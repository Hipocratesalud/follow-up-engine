import {
  describeAuditLogContract,
  describeCaseRepositoryContract,
  describeClinicalRecordRepositoryContract,
  describeClinicDirectoryContract,
  describeConditionRepositoryContract,
  describeExpectationRepositoryContract,
  describeFeedbackRepositoryContract,
  describeJobQueueContract,
  describeLlmUsageLogContract,
  describeOutboxContract,
  describeQualityFindingRepositoryContract,
  describeUnitOfWorkContract,
} from '../src/index.ts';
import {
  memoryClinicDirectory,
  MemoryDb,
  memoryLlmUsageLog,
  memoryStores,
  memoryUnitOfWork,
} from './memory/memory-stores.ts';

// Proves every suite is runnable and satisfiable, against a throwaway in-memory implementation.
const NAME = 'throwaway memory';
const noop = () => Promise.resolve();

function fromStores<T>(pick: (stores: ReturnType<typeof memoryStores>) => T) {
  return () => Promise.resolve({ subject: pick(memoryStores(new MemoryDb())), cleanup: noop });
}

describeExpectationRepositoryContract(
  NAME,
  fromStores((s) => s.expectations),
);
describeCaseRepositoryContract(
  NAME,
  fromStores((s) => s.cases),
);
describeClinicalRecordRepositoryContract(
  NAME,
  fromStores((s) => s.clinicalRecords),
);
describeFeedbackRepositoryContract(
  NAME,
  fromStores((s) => s.feedback),
);
describeConditionRepositoryContract(
  NAME,
  fromStores((s) => s.conditions),
);
describeQualityFindingRepositoryContract(
  NAME,
  fromStores((s) => s.qualityFindings),
);
describeAuditLogContract(
  NAME,
  fromStores((s) => s.audit),
);
describeJobQueueContract(
  NAME,
  fromStores((s) => s.jobs),
);

describeOutboxContract(NAME, () => {
  const { outbox } = memoryStores(new MemoryDb());
  return Promise.resolve({
    subject: outbox,
    pending: (clinic) => outbox.pending(clinic),
    cleanup: noop,
  });
});

describeUnitOfWorkContract(NAME, () => {
  const db = new MemoryDb();
  const { outbox } = memoryStores(db);
  return Promise.resolve({
    subject: memoryUnitOfWork(db),
    pendingOutbox: (clinic) => outbox.pending(clinic),
    cleanup: noop,
  });
});

describeClinicDirectoryContract(NAME, (seed) =>
  Promise.resolve({ subject: memoryClinicDirectory(seed), cleanup: noop }),
);

describeLlmUsageLogContract(NAME, () =>
  Promise.resolve({ subject: memoryLlmUsageLog(), cleanup: noop }),
);
