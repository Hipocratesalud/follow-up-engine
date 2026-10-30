import {
  createMemoryStores,
  DEFAULT_CLINIC_SETTINGS,
  FakeNoteExtractor,
  FileEscalationPolicySource,
  FileProtocolSource,
  FileRuleSource,
  MemoryClinicDirectory,
  MemoryDatabase,
  MemoryUnitOfWork,
  SequentialIdGenerator,
  tenantKey,
} from '@follow-up-engine/adapter-memory';
import type { IsolatedDatabase } from '@follow-up-engine/adapter-postgres/testing';
import {
  type Clinic,
  type ClinicalBatch,
  type ClinicDirectory,
  type ClinicId,
  type ClinicSettings,
  createFollowUpEngine,
  type DomainEvent,
  type EngineSettings,
  FakeClock,
  type FollowUpEngine,
  type IngestReport,
  isOlderResourceVersion,
  type NoteExtractor,
  type RuleOverrideStore,
  type TransactionalStores,
  type UnitOfWork,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';

export type AdapterName = 'memory' | 'postgres';

/** The engine wired over one adapter family, with a fake clock and handles for assertions. */
export interface EngineHarness {
  readonly adapter: AdapterName;
  readonly clinicId: ClinicId;
  readonly clock: FakeClock;
  readonly engine: FollowUpEngine;
  readonly unitOfWork: UnitOfWork;
  readonly clinics: ClinicDirectory;
  /** Runs read-only work in a transaction scoped to the clinic. */
  read<TResult>(work: (stores: TransactionalStores) => Promise<TResult>): Promise<TResult>;
  /** Outbox events of the clinic not delivered yet, in insertion order. */
  pendingEvents(): Promise<readonly DomainEvent[]>;
  /**
   * Fault injection: deletes a case row behind the engine's back (no port
   * deletes cases; the reconciliation must notice and repair it).
   */
  deleteCaseRow(caseId: string): Promise<void>;
}

export interface HarnessOptions {
  readonly clinicId: ClinicId;
  readonly start: Date;
  readonly extractor?: NoteExtractor;
  readonly settings?: Partial<ClinicSettings>;
  readonly engineSettings?: Partial<EngineSettings>;
  /** Wraps the unit of work the engine uses (to inject a crash). */
  readonly wrapUnitOfWork?: (unitOfWork: UnitOfWork) => UnitOfWork;
}

function clinicOf(options: HarnessOptions): Clinic {
  return {
    id: options.clinicId,
    name: `Clinic ${options.clinicId}`,
    active: true,
    settings: { ...DEFAULT_CLINIC_SETTINGS, ...options.settings },
  };
}

function engineOver(
  options: HarnessOptions,
  ports: {
    unitOfWork: UnitOfWork;
    clinics: ClinicDirectory;
    clock: FakeClock;
    ruleOverrides: RuleOverrideStore;
  },
): FollowUpEngine {
  return createFollowUpEngine({
    unitOfWork: options.wrapUnitOfWork?.(ports.unitOfWork) ?? ports.unitOfWork,
    ruleOverrides: ports.ruleOverrides,
    noteExtractor: options.extractor ?? new FakeNoteExtractor(),
    rules: new FileRuleSource(),
    protocols: new FileProtocolSource(),
    escalationPolicies: new FileEscalationPolicySource(),
    clinics: ports.clinics,
    clock: ports.clock,
    ids: new SequentialIdGenerator(),
    ...(options.engineSettings === undefined ? {} : { settings: options.engineSettings }),
  });
}

/** The engine on `adapter-memory`. */
export function memoryHarness(options: HarnessOptions): EngineHarness {
  const clock = new FakeClock(options.start);
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, clock);
  const unitOfWork = new MemoryUnitOfWork(db, stores);
  const clinics = new MemoryClinicDirectory([{ clinic: clinicOf(options) }]);
  return {
    adapter: 'memory',
    clinicId: options.clinicId,
    clock,
    engine: engineOver(options, {
      unitOfWork,
      clinics,
      clock,
      ruleOverrides: stores.ruleOverrides,
    }),
    unitOfWork,
    clinics,
    read: (work) => unitOfWork.withTransaction(options.clinicId, work),
    pendingEvents: () => stores.outbox.pending(options.clinicId),
    deleteCaseRow: (caseId) => {
      db.deleteIn(db.state.cases, tenantKey(options.clinicId, caseId));
      return Promise.resolve();
    },
  };
}

/** The engine on `adapter-postgres`, in an isolated schema (one clinic per harness). */
export async function postgresHarness(
  database: IsolatedDatabase,
  options: HarnessOptions,
): Promise<EngineHarness> {
  const clock = new FakeClock(options.start);
  const adapters = database.adapters({ clock });
  const clinic = clinicOf(options);
  await adapters.clinics.register({
    id: clinic.id,
    name: clinic.name,
    settings: clinic.settings,
  });
  return {
    adapter: 'postgres',
    clinicId: options.clinicId,
    clock,
    engine: engineOver(options, {
      unitOfWork: adapters.unitOfWork,
      clinics: adapters.clinics,
      clock,
      ruleOverrides: adapters.ruleOverrides,
    }),
    unitOfWork: adapters.unitOfWork,
    clinics: adapters.clinics,
    read: (work) => adapters.unitOfWork.withTransaction(options.clinicId, work),
    pendingEvents: () => adapters.outbox.pending(options.clinicId),
    deleteCaseRow: async (caseId) => {
      await adapters
        .db()
        .query(
          `DELETE FROM "${database.schema}".follow_up_cases WHERE clinic_id = $1 AND id = $2`,
          [options.clinicId, caseId],
        );
    },
  };
}

/** Thrown when a bundle the tests feed the engine does not map cleanly. */
export class BundleMappingError extends Error {
  override readonly name = 'BundleMappingError';
}

/**
 * What the API does with a FHIR transaction: map it, store its resources,
 * ingest every batch. The bundle must map without errors.
 */
export async function ingestBundle(
  harness: Pick<EngineHarness, 'clinicId' | 'unitOfWork' | 'engine'>,
  bundle: unknown,
  receivedAt: Date,
): Promise<IngestReport[]> {
  const mapped = mapBundleToBatches(bundle, { clinicId: harness.clinicId, receivedAt });
  const errors = (mapped.issues?.issue ?? []).filter(
    (issue) => issue.severity === 'error' || issue.severity === 'fatal',
  );
  if (errors.length > 0) {
    throw new BundleMappingError(errors.map((issue) => issue.diagnostics ?? '').join('; '));
  }
  // Like the runtime: an older version than the one stored is not ingested.
  const stale = new Set<string>();
  await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
    for (const { patientId, resource } of mapped.resources) {
      const stored = await stores.clinicalRecords.getResource(harness.clinicId, resource);
      if (stored !== undefined && isOlderResourceVersion(resource, stored.resource)) {
        stale.add(`${resource.resourceType}/${resource.id}`);
      }
      await stores.clinicalRecords.saveResource(harness.clinicId, patientId, resource, receivedAt);
    }
  });
  const reports: IngestReport[] = [];
  for (const batch of mapped.batches) {
    const events = batch.events.filter(
      (event) => !stale.has(`${event.source.resourceType}/${event.source.id}`),
    );
    if (events.length > 0) {
      reports.push(await harness.engine.ingest({ ...batch, events } satisfies ClinicalBatch));
    }
  }
  return reports;
}
