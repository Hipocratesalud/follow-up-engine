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
import {
  type ApiKeyScope,
  generateApiKey,
  hashApiKey,
  INBOX_SCOPES,
  INTEGRATION_SCOPES,
} from './api-keys.ts';
import { DEV_WEBHOOK_SECRET, PUBLIC_DEMO_KEYS, type RuntimeConfig } from './config.ts';
import { createWebhookPublisher } from './webhooks/publisher.ts';
import { createLoopbackPublisher, WebhookSink } from './webhooks/sink.ts';
import { IngestionService } from './ingestion.ts';
import { createConfiguredExtractor, type ExtractorInfo } from './llm.ts';
import { createLogger, type Logger } from './logger.ts';
import { createMemoryStorage, createPostgresStorage, type Storage } from './storage.ts';

/** Id and name of the synthetic demo clinic (fictional). */
export const DEMO_CLINIC = { id: 'clinic-demo', name: 'Clínica Demo Hipócrates' } as const;

/** Label of the demo clinic's inbox key (`DEMO_INBOX_API_KEY`). */
export const DEMO_INBOX_KEY_LABEL = 'demo inbox';

/** Who a request is: the clinic of its API key and what that key may do. */
export interface Principal {
  readonly clinic: Clinic;
  readonly scopes: readonly ApiKeyScope[];
}

/** A key just issued: shown once, then only its hash exists. */
export interface IssuedApiKey {
  readonly apiKey: string;
  readonly clinicId: ClinicId;
  readonly label: string;
  readonly scopes: readonly ApiKeyScope[];
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
  /**
   * Registers or updates a clinic with its integration API key (stored as a
   * sha256 hash; scopes {@link INTEGRATION_SCOPES}).
   */
  registerClinic(input: {
    readonly id: string;
    readonly name: string;
    readonly apiKey: string;
    readonly settings?: Partial<Clinic['settings']>;
  }): Promise<Clinic>;
  /**
   * Issues a scoped key for an existing clinic. Without `apiKey` a random
   * one is generated; the result is the only time it is visible.
   */
  issueApiKey(input: {
    readonly clinicId: string;
    readonly label: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly apiKey?: string;
  }): Promise<IssuedApiKey>;
  /**
   * The clinic and scopes of an API key; `undefined` for an unknown,
   * revoked or inactive one, and for the public demo keys outside a fake
   * clock (a production database seeded once by the demo stays closed).
   */
  authenticate(apiKey: string): Promise<Principal | undefined>;
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
    async issueApiKey(input) {
      const clinicId = toClinicId(input.clinicId);
      if ((await storage.clinics.get(clinicId)) === undefined) {
        throw new Error(`Clinic ${clinicId} does not exist`);
      }
      const apiKey = input.apiKey ?? generateApiKey();
      await storage.apiKeys.issue({
        keyHash: hashApiKey(apiKey),
        clinicId,
        label: input.label,
        scopes: input.scopes,
        createdAt: clock.now(),
      });
      return { apiKey, clinicId, label: input.label, scopes: input.scopes };
    },
    async authenticate(apiKey) {
      if (fakeClock === undefined && PUBLIC_DEMO_KEYS.includes(apiKey)) {
        return undefined;
      }
      const keyHash = hashApiKey(apiKey);
      const scoped = await storage.apiKeys.findByHash(keyHash);
      if (scoped !== undefined) {
        const clinic = await storage.clinics.get(scoped.clinicId);
        return clinic?.active === true ? { clinic, scopes: scoped.scopes } : undefined;
      }
      const clinic = await storage.clinics.findByApiKeyHash(keyHash);
      if (clinic?.active !== true) {
        return undefined;
      }
      // The demo clinic's own key also drives the demo (only on a fake clock).
      const demo = fakeClock !== undefined && clinic.id === DEMO_CLINIC.id;
      return { clinic, scopes: demo ? [...INTEGRATION_SCOPES, 'demo'] : INTEGRATION_SCOPES };
    },
    close: () => storage.close(),
  };

  if (config.clock.kind === 'system' && config.webhooks.secret === DEV_WEBHOOK_SECRET) {
    logger.warn(
      'WEBHOOK_SECRET is the public development default: set a long random secret shared with the host',
    );
  }
  if (config.demo !== undefined) {
    await registerDemoClinic(runtime, config.demo.apiKey, config.demo.inboxApiKey);
    logger.info(
      { clinicId: DEMO_CLINIC.id, inboxKey: config.demo.inboxApiKey !== undefined },
      'demo clinic registered',
    );
  } else if (config.ignoredDemoApiKey) {
    logger.warn(
      'DEMO_API_KEY is ignored with CLOCK=system: the demo clinic is only registered on a fake ' +
        'clock, or with DEMO_CLINIC=true and non-public keys',
    );
  }
  return runtime;
}

/**
 * Registers the synthetic demo clinic with `DEMO_API_KEY` (the host
 * integration key, plus `demo` on a fake clock) and, when given, an inbox
 * key with `DEMO_INBOX_API_KEY` (`inbox:read`, `inbox:act`, `demo`: never
 * `fhir:write`). Patient contact is enabled so the demo shows
 * `patient_contact.requested` webhooks.
 */
export async function registerDemoClinic(
  runtime: EngineRuntime,
  apiKey: string,
  inboxApiKey?: string,
): Promise<Clinic> {
  const clinic = await runtime.registerClinic({
    id: DEMO_CLINIC.id,
    name: DEMO_CLINIC.name,
    apiKey,
    settings: { allowPatientContact: true, timezone: 'America/Caracas' },
  });
  if (inboxApiKey !== undefined) {
    await runtime.issueApiKey({
      clinicId: DEMO_CLINIC.id,
      label: DEMO_INBOX_KEY_LABEL,
      scopes: [...INBOX_SCOPES, 'demo'],
      apiKey: inboxApiKey,
    });
  }
  return clinic;
}

/** Active clinics, for the sweeps. */
export async function activeClinicIds(runtime: EngineRuntime): Promise<readonly ClinicId[]> {
  return (await runtime.storage.clinics.listActive()).map((clinic) => clinic.id);
}
