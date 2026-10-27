import type { PostgresAdapters } from '@follow-up-engine/adapter-postgres';
import {
  describeAuditLogContract,
  describeBackfillProgressStoreContract,
  describeCaseRepositoryContract,
  describeContactRepositoryContract,
  describeClinicalRecordRepositoryContract,
  describeClinicDirectoryContract,
  describeConditionRepositoryContract,
  describeExpectationRepositoryContract,
  describeFeedbackRepositoryContract,
  describeJobQueueContract,
  describeLlmUsageLogContract,
  describeOutboxContract,
  describeQualityFindingRepositoryContract,
  describeSuppressionRepositoryContract,
  describeUnitOfWorkContract,
} from '@follow-up-engine/testkit';
import { describe } from 'vitest';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

const NAME = 'adapter-postgres';
const noop = (): Promise<void> => Promise.resolve();

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('contract suites'), () => {
  const database = useIsolatedDatabase();
  const adapters = (): PostgresAdapters => database().adapters();

  function store<TSubject>(pick: (all: PostgresAdapters) => TSubject) {
    return () => Promise.resolve({ subject: pick(adapters()), cleanup: noop });
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

  describeOutboxContract(NAME, () => {
    const { outbox } = adapters();
    return Promise.resolve({
      subject: outbox,
      pending: (clinic) => outbox.pending(clinic),
      cleanup: noop,
    });
  });

  describeUnitOfWorkContract(NAME, () => {
    const all = adapters();
    return Promise.resolve({
      subject: all.unitOfWork,
      pendingOutbox: (clinic) => all.outbox.pending(clinic),
      cleanup: noop,
    });
  });

  describeClinicDirectoryContract(NAME, async (seed) => {
    const all = adapters();
    for (const { clinic, apiKeyHash } of seed) {
      await all.clinics.register({
        id: clinic.id,
        name: clinic.name,
        active: clinic.active,
        settings: clinic.settings,
        apiKeyHash,
      });
    }
    return { subject: all.clinics, cleanup: noop };
  });

  describeLlmUsageLogContract(NAME, () =>
    Promise.resolve({ subject: adapters().llmUsage, cleanup: noop }),
  );
});
