import { createHash } from 'node:crypto';
import {
  FileProtocolSource,
  FileRuleSource,
  UuidIdGenerator,
} from '@follow-up-engine/adapter-memory';
import {
  type Clinic,
  type ClinicId,
  clinicId as toClinicId,
  type Clock,
  createFollowUpEngine,
  type EventPublisher,
  FakeClock,
  type FollowUpEngine,
  type IdGenerator,
  SystemClock,
} from '@follow-up-engine/core';
import type { NoteFixture } from '@follow-up-engine/llm';
import type { RuntimeConfig } from './config.ts';
import { createWebhookPublisher } from './webhooks/publisher.ts';
import { createLoopbackPublisher, WebhookSink } from './webhooks/sink.ts';
import { IngestionService } from './ingestion.ts';
import { createConfiguredExtractor, type ExtractorInfo } from './llm.ts';
import { createLogger, type Logger } from './logger.ts';
import { createMemoryStorage, createPostgresStorage, type Storage } from './storage.ts';

/** Id and name of the synthetic demo clinic (fictional). */
export const DEMO_CLINIC = { id: 'clinic-demo', name: 'Clínica Demo Hipócrates' } as const;

/** sha256 hex of an API key: the only form in which keys are stored or compared. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * The engine, fully wired: what both the API and the worker run on. Built
 * once per process by {@link createRuntime}, the composition root that picks
 * every adapter from the configuration.
 */
export interface EngineRuntime {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  /** Present when `CLOCK=fake` (demos, e2e): time only moves when told to. */
  readonly fakeClock?: FakeClock;
  readonly storage: Storage;
  readonly engine: FollowUpEngine;
  readonly extractor: ExtractorInfo;
  readonly ingestion: IngestionService;
  /** Delivers outbox events to the host (signed webhooks). */
  readonly publisher: EventPublisher;
  /** The in-process webhook sink, when no `WEBHOOK_URL` is configured (demo). */
  readonly sink?: WebhookSink;
  readonly logger: Logger;
  /** Registers or updates a clinic with its API key (stored as a sha256 hash). */
  registerClinic(input: {
    readonly id: string;
    readonly name: string;
    readonly apiKey: string;
    readonly settings?: Partial<Clinic['settings']>;
  }): Promise<Clinic>;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  /** Process name in the logs (`api`, `worker`). */
  readonly service?: string;
  readonly logger?: Logger;
  /** Scripted note readings for the fake LLM provider (tests, seeds). */
  readonly noteFixtures?: readonly NoteFixture[];
  /** Deterministic ids (tests). UUIDs by default. */
  readonly ids?: IdGenerator;
  /** Size of the Postgres pool. */
  readonly poolSize?: number;
}

/**
 * The composition root. Chooses, from the configuration and nothing else:
 * Postgres or memory storage (`DATABASE_URL`), system or fake clock
 * (`CLOCK`), the LLM provider behind the gateway (`LLM_PROVIDER`), and
 * where webhooks go (`WEBHOOK_URL`, else an in-process signed sink).
 */
export async function createRuntime(
  config: RuntimeConfig,
  options: CreateRuntimeOptions = {},
): Promise<EngineRuntime> {
  const service = options.service ?? 'engine';
  const logger = options.logger ?? createLogger({ level: config.logLevel, service });
  const fakeClock = config.clock.kind === 'fake' ? new FakeClock(config.clock.start) : undefined;
  const clock: Clock = fakeClock ?? new SystemClock();

  const storage =
    config.databaseUrl === undefined
      ? createMemoryStorage(clock)
      : await createPostgresStorage({
          connectionString: config.databaseUrl,
          clock,
          applicationName: `follow-up-engine-${service}`,
          ...(config.databaseSchema === undefined ? {} : { schema: config.databaseSchema }),
          ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
        });

  const { extractor, info } = createConfiguredExtractor(config.llm, {
    usageLog: storage.llmUsage,
    clinics: storage.clinics,
    clock,
    ...(options.noteFixtures === undefined ? {} : { noteFixtures: options.noteFixtures }),
  });

  const engine = createFollowUpEngine({
    unitOfWork: storage.unitOfWork,
    noteExtractor: extractor,
    rules: new FileRuleSource(),
    protocols: new FileProtocolSource(),
    clinics: storage.clinics,
    clock,
    ids: options.ids ?? new UuidIdGenerator(),
  });

  const { url: webhookUrl, secret: webhookSecret } = config.webhooks;
  let sink: WebhookSink | undefined;
  let publisher: EventPublisher;
  if (webhookUrl === undefined) {
    // The in-process sink stamps deliveries with the engine clock, so a demo
    // on a fake clock shows them on the simulated timeline.
    sink = new WebhookSink({ secret: webhookSecret, now: () => clock.now() });
    publisher = createLoopbackPublisher(sink, webhookSecret);
  } else {
    publisher = createWebhookPublisher({ url: webhookUrl, secret: webhookSecret });
  }

  logger.info(
    {
      storage: storage.kind,
      clock: config.clock.kind,
      llmProvider: info.provider,
      llmModel: info.model,
      webhooks: config.webhooks.url === undefined ? 'in-process sink' : 'http',
    },
    'engine runtime ready',
  );

  const runtime: EngineRuntime = {
    config,
    clock,
    ...(fakeClock === undefined ? {} : { fakeClock }),
    storage,
    engine,
    extractor: info,
    ingestion: new IngestionService({ storage, engine, clock }),
    publisher,
    ...(sink === undefined ? {} : { sink }),
    logger,
    registerClinic: (input) =>
      storage.registerClinic({
        id: toClinicId(input.id),
        name: input.name,
        apiKeyHash: hashApiKey(input.apiKey),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      }),
    close: () => storage.close(),
  };

  if (config.demoApiKey !== undefined) {
    await registerDemoClinic(runtime, config.demoApiKey);
  }
  return runtime;
}

/**
 * Registers the synthetic demo clinic with `DEMO_API_KEY`. Patient contact
 * is enabled so the demo shows `patient_contact.requested` webhooks.
 */
export function registerDemoClinic(runtime: EngineRuntime, apiKey: string): Promise<Clinic> {
  return runtime.registerClinic({
    id: DEMO_CLINIC.id,
    name: DEMO_CLINIC.name,
    apiKey,
    settings: { allowPatientContact: true, timezone: 'America/Caracas' },
  });
}

/** Active clinics, for the sweeps. */
export async function activeClinicIds(runtime: EngineRuntime): Promise<readonly ClinicId[]> {
  return (await runtime.storage.clinics.listActive()).map((clinic) => clinic.id);
}
