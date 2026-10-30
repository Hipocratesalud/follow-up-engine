import {
  createMemoryStores,
  DEFAULT_CLINIC_SETTINGS as MEMORY_DEFAULT_SETTINGS,
  MemoryClinicDirectory,
  MemoryDatabase,
  MemoryLlmUsageLog,
  MemoryHeldLabReportStore,
  MemoryOrderAgentStore,
  MemoryUnitOfWork,
} from '@follow-up-engine/adapter-memory';
import {
  createPool,
  createPostgresAdapters,
  migrate,
  type PostgresAdapters,
  PostgresHeldLabReportStore,
  PostgresOrderAgentStore,
} from '@follow-up-engine/adapter-postgres';
import type {
  Clinic,
  ClinicDirectory,
  ClinicId,
  ClinicSettings,
  Clock,
  EventPublisher,
  HeldLabReportStore,
  JobQueue,
  LlmUsageLog,
  OrderAgentStore,
  TransactionalStores,
  UnitOfWork,
} from '@follow-up-engine/core';
import { type ApiKeyStore, MemoryApiKeyStore, PostgresApiKeyStore } from './api-keys.ts';
import {
  type EvaluatorEventStore,
  MemoryEvaluatorEventStore,
  PostgresEvaluatorEventStore,
} from './evaluator-events.ts';
import { MemoryReadModel, PostgresReadModel, type ReadModel } from './read-model.ts';

/** A clinic to register (provisioning, seeds, tests). */
export interface ClinicRegistration {
  readonly id: ClinicId;
  readonly name: string;
  readonly active?: boolean;
  readonly settings?: Partial<ClinicSettings>;
  /** sha256 hex of the clinic's API key. */
  readonly apiKeyHash?: string;
}

export interface DrainResult {
  readonly delivered: number;
  readonly retrying: number;
  readonly dead: number;
}

/**
 * Everything the runtime needs from persistence, whichever backend: the
 * core ports, plus provisioning, outbox delivery and the read queries the
 * inbox needs that the ports do not offer (see {@link ReadModel}).
 */
export interface Storage {
  readonly kind: 'memory' | 'postgres';
  readonly unitOfWork: UnitOfWork;
  /** Stores bound to no transaction (each call is its own statement). */
  readonly stores: TransactionalStores;
  readonly jobs: JobQueue;
  readonly clinics: ClinicDirectory;
  readonly llmUsage: LlmUsageLog;
  readonly readModel: ReadModel;
  /** Scoped API keys of every clinic. */
  readonly apiKeys: ApiKeyStore;
  /** The evaluator lab's append-only action log (docs/deploy.md#hosted-demo), cross-clinic. */
  readonly evaluatorEvents: EvaluatorEventStore;
  /** The order-to-completion agent's conversations, trace, tasks and bookings. */
  readonly orderAgent: OrderAgentStore;
  /** Imported lab reports held for the team (the name on the report is not the patient's). */
  readonly heldLabReports: HeldLabReportStore;
  registerClinic(registration: ClinicRegistration): Promise<Clinic>;
  /** Delivers pending outbox events (every clinic) through `publisher`. */
  drainOutbox(publisher: EventPublisher, now: Date, limit: number): Promise<DrainResult>;
  /** Throws when the backend is unreachable (readiness probe). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** In-memory storage: the offline demo and unit tests. Lost on restart. */
export function createMemoryStorage(clock: Clock): Storage & { readonly db: MemoryDatabase } {
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, clock);
  const clinics = new MemoryClinicDirectory();
  return {
    kind: 'memory',
    db,
    unitOfWork: new MemoryUnitOfWork(db, stores),
    stores,
    jobs: stores.jobs,
    clinics,
    llmUsage: new MemoryLlmUsageLog(db),
    readModel: new MemoryReadModel(db),
    apiKeys: new MemoryApiKeyStore(),
    evaluatorEvents: new MemoryEvaluatorEventStore(),
    orderAgent: new MemoryOrderAgentStore(),
    heldLabReports: new MemoryHeldLabReportStore(),
    registerClinic(registration) {
      const clinic: Clinic = {
        id: registration.id,
        name: registration.name,
        active: registration.active ?? true,
        settings: { ...MEMORY_DEFAULT_SETTINGS, ...registration.settings },
      };
      clinics.add(clinic, registration.apiKeyHash);
      return Promise.resolve(clinic);
    },
    async drainOutbox(publisher, now) {
      // The memory outbox keeps no attempt counter: a failure stops the pass
      // and the remaining events are retried on the next one.
      try {
        const delivered = await stores.outbox.deliverPending(publisher, now);
        return { delivered, retrying: 0, dead: 0 };
      } catch {
        return { delivered: 0, retrying: 1, dead: 0 };
      }
    },
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

export interface PostgresStorageOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly clock: Clock;
  /** Run pending migrations at startup. Default true. */
  readonly migrate?: boolean;
  readonly poolSize?: number;
  readonly applicationName?: string;
}

/** Postgres (vanilla or Supabase) storage. Migrates the schema at startup. */
export async function createPostgresStorage(
  options: PostgresStorageOptions,
): Promise<Storage & { readonly adapters: PostgresAdapters }> {
  const pool = createPool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    applicationName: options.applicationName ?? 'follow-up-engine',
  });
  try {
    if (options.migrate ?? true) {
      await migrate(pool, options.schema === undefined ? {} : { schema: options.schema });
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  const adapters = createPostgresAdapters(pool, {
    clock: options.clock,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  return {
    kind: 'postgres',
    adapters,
    unitOfWork: adapters.unitOfWork,
    stores: adapters,
    jobs: adapters.jobs,
    clinics: adapters.clinics,
    llmUsage: adapters.llmUsage,
    readModel: new PostgresReadModel(adapters.db, options.schema),
    apiKeys: new PostgresApiKeyStore(adapters.db, options.schema),
    evaluatorEvents: new PostgresEvaluatorEventStore(adapters.db, options.schema),
    orderAgent: new PostgresOrderAgentStore(adapters.db, options.schema),
    heldLabReports: new PostgresHeldLabReportStore(adapters.db, options.schema),
    registerClinic: (registration) =>
      adapters.clinics.register({
        id: registration.id,
        name: registration.name,
        ...(registration.active === undefined ? {} : { active: registration.active }),
        ...(registration.settings === undefined ? {} : { settings: registration.settings }),
        ...(registration.apiKeyHash === undefined ? {} : { apiKeyHash: registration.apiKeyHash }),
      }),
    drainOutbox: (publisher, now, limit) =>
      adapters.drainOutbox({ publisher, now, limit, leaseFor: { minutes: 1 } }),
    async ping() {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
