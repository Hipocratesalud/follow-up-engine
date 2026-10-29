import { createHash } from 'node:crypto';
import {
  FileEscalationPolicySource,
  FileProtocolSource,
  loadConfigDirectory,
  FileRuleSource,
  UuidIdGenerator,
} from '@follow-up-engine/adapter-memory';
import {
  type Clinic,
  type ClinicalReviewer,
  type ClinicId,
  clinicId as toClinicId,
  type Clock,
  createClinicalReviewer,
  createFollowUpEngine,
  DEFAULT_REVIEW_LOCALE,
  type EventPublisher,
  FakeClock,
  type FollowUpEngine,
  type IdGenerator,
  primaryLanguage,
  REVIEW_LOCALES,
  type ReviewLocale,
  type Rule,
  shadowPilotFlags,
  SystemClock,
} from '@follow-up-engine/core';
import type { NoteFixture } from '@follow-up-engine/llm';
import {
  ApiKeyConflictError,
  type ApiKeyScope,
  DEMO_SCOPES,
  generateApiKey,
  hashApiKey,
  INBOX_SCOPES,
  INTEGRATION_SCOPES,
  isDemoScope,
} from './api-keys.ts';
import {
  DEV_WEBHOOK_SECRET,
  MIN_PRODUCTION_KEY_LENGTH,
  PUBLIC_DEMO_KEYS,
  type RuntimeConfig,
} from './config.ts';
import { createWebhookPublisher } from './webhooks/publisher.ts';
import { createLoopbackPublisher, WebhookSink } from './webhooks/sink.ts';
import { IngestionService } from './ingestion.ts';
import {
  type ConfiguredExtractor,
  createConfiguredExtractor,
  type ExtractorInfo,
  type LlmSnapshotOption,
} from './llm.ts';
import { createLogger, type Logger } from './logger.ts';
import { patientRedactTerms, withPatientRedaction } from './redaction.ts';
import { createMemoryStorage, createPostgresStorage, type Storage } from './storage.ts';

/** Id and name of the synthetic demo clinic (fictional). */
export const DEMO_CLINIC = { id: 'clinic-demo', name: 'Clínica Demo Hipócrates' } as const;

/**
 * Backfill release cap of the demo clinic, per owner and day. Lower than the
 * production default (20) so the synthetic clinic's day 0 shows a capped
 * inbox, "Por recuperar" holds the rest and each simulated day releases the
 * next batch. Demo seed only; real clinics keep their own setting.
 */
export const DEMO_DAILY_CASE_CAP_PER_OWNER = 5;

/**
 * Escalation policy of the demo clinic: WhatsApp at day 14, a front-desk
 * call at day 21 if nobody answered, a second WhatsApp at day 28, lost only
 * once every attempt is over.
 */
export const DEMO_ESCALATION_POLICY = 'default_v2';

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
  /** The clinical reviewer (PRD V3): shadow findings, flags, review runs. */
  readonly reviewer: ClinicalReviewer;
  readonly extractor: ExtractorInfo;
  /** Replay of a recorded model snapshot (`CreateRuntimeOptions.llmSnapshot`): hits and live calls. */
  readonly llmReplay?: ConfiguredExtractor['replay'];
  readonly ingestion: IngestionService;
  /** Delivers outbox events to the host (signed webhooks). */
  readonly publisher: EventPublisher;
  /** The in-process webhook sink, when no `WEBHOOK_URL` is configured (demo). */
  readonly sink?: WebhookSink;
  readonly logger: Logger;
  /**
   * Registers or updates a clinic with its integration API key (stored as a
   * sha256 hash; scopes {@link INTEGRATION_SCOPES}). Throws
   * {@link ApiKeyConflictError} when another clinic holds that key value.
   */
  registerClinic(input: {
    readonly id: string;
    readonly name: string;
    readonly apiKey: string;
    readonly settings?: Partial<Clinic['settings']>;
  }): Promise<Clinic>;
  /**
   * Issues a scoped key for an existing clinic. Without `apiKey` a random
   * one is generated; the result is the only time it is visible. Throws
   * {@link ApiKeyConflictError} when another clinic holds that key value
   * (revoked or not): key values are unique across clinics.
   */
  issueApiKey(input: {
    readonly clinicId: string;
    readonly label: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly apiKey?: string;
  }): Promise<IssuedApiKey>;
  /**
   * The clinic and scopes of an API key; `undefined` for an unknown,
   * revoked or inactive one. On a real clock the demo clinic answers only
   * with `DEMO_CLINIC=true` and a private key of 24+ characters (a
   * production database seeded once by the demo stays closed, whatever
   * demo keys it kept), and `demo:*` scopes are dropped.
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
  /** Recorded replies of the configured model to replay (the demo's Muse Spark snapshot). */
  readonly llmSnapshot?: LlmSnapshotOption;
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

  const { extractor, info, reviewAgent, replay } = createConfiguredExtractor(config.llm, {
    usageLog: storage.llmUsage,
    clinics: storage.clinics,
    clock,
    ...(options.noteFixtures === undefined ? {} : { noteFixtures: options.noteFixtures }),
    ...(options.llmSnapshot === undefined ? {} : { snapshot: options.llmSnapshot }),
  });

  const engine = createFollowUpEngine({
    unitOfWork: storage.unitOfWork,
    // The patient's names and identifiers are masked before a note leaves for a model.
    noteExtractor: withPatientRedaction(extractor, storage.stores.clinicalRecords),
    rules: new FileRuleSource(),
    protocols: new FileProtocolSource(),
    escalationPolicies: new FileEscalationPolicySource(),
    // Per-clinic overrides (clinic:rules, PUT /api/admin/rules) layer over config/rules.
    ruleOverrides: storage.stores.ruleOverrides,
    clinics: storage.clinics,
    clock,
    ids: options.ids ?? new UuidIdGenerator(),
  });
  const reviewer = createClinicalReviewer({
    unitOfWork: storage.unitOfWork,
    clock,
    ids: options.ids ?? new UuidIdGenerator(),
    agent: reviewAgent,
    // Names and identifiers never reach the model (masked in the input and every tool result).
    redactTermsOf: patientRedactTerms,
    // What each open expectation asks for: a finding a protocol item already covers says so.
    loadCatalog: (clinicId) => engine.catalog(clinicId),
    // Findings are written in the clinic's language (ClinicSettings.locale), English by default.
    localeOf: async (clinicId) =>
      reviewLocaleOf((await storage.clinics.get(clinicId))?.settings.locale),
    // What the host sends in full: a missing allergy status is a finding only then.
    recordCapabilitiesOf: async (clinicId) =>
      (await storage.clinics.get(clinicId))?.settings.recordCapabilities ?? [],
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

  /** Key values are unique across clinics: scoped keys and integration keys alike. */
  async function assertKeyFree(keyHash: string, clinicId: ClinicId): Promise<void> {
    const holder =
      (await storage.apiKeys.holderOf(keyHash)) ??
      (await storage.clinics.findByApiKeyHash(keyHash))?.id;
    if (holder !== undefined && holder !== clinicId) {
      throw new ApiKeyConflictError();
    }
  }

  async function lookUp(apiKey: string): Promise<Principal | undefined> {
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
    return { clinic, scopes: demo ? [...INTEGRATION_SCOPES, ...DEMO_SCOPES] : INTEGRATION_SCOPES };
  }

  /** `DEMO_CLINIC=true` and a key that could have passed its startup check. */
  function demoOpenOnRealClock(apiKey: string): boolean {
    return (
      config.demo !== undefined &&
      apiKey.length >= MIN_PRODUCTION_KEY_LENGTH &&
      !PUBLIC_DEMO_KEYS.includes(apiKey)
    );
  }

  const runtime: EngineRuntime = {
    config,
    clock,
    ...(fakeClock === undefined ? {} : { fakeClock }),
    storage,
    engine,
    reviewer,
    extractor: info,
    ...(replay === undefined ? {} : { llmReplay: replay }),
    ingestion: new IngestionService({ storage, engine, clock }),
    publisher,
    ...(sink === undefined ? {} : { sink }),
    logger,
    async registerClinic(input) {
      const id = toClinicId(input.id);
      const apiKeyHash = hashApiKey(input.apiKey);
      await assertKeyFree(apiKeyHash, id);
      return storage.registerClinic({
        id,
        name: input.name,
        apiKeyHash,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      });
    },
    async issueApiKey(input) {
      const clinicId = toClinicId(input.clinicId);
      if ((await storage.clinics.get(clinicId)) === undefined) {
        throw new Error(`Clinic ${clinicId} does not exist`);
      }
      const apiKey = input.apiKey ?? generateApiKey();
      const keyHash = hashApiKey(apiKey);
      await assertKeyFree(keyHash, clinicId);
      await storage.apiKeys.issue({
        keyHash,
        clinicId,
        label: input.label,
        scopes: input.scopes,
        createdAt: clock.now(),
      });
      return { apiKey, clinicId, label: input.label, scopes: input.scopes };
    },
    async authenticate(apiKey) {
      const principal = await lookUp(apiKey);
      if (principal === undefined || fakeClock !== undefined) {
        return principal;
      }
      // A real clock: the demo clinic stays closed unless explicitly enabled
      // with private keys, and no key moves a clock that does not exist.
      if (principal.clinic.id === DEMO_CLINIC.id && !demoOpenOnRealClock(apiKey)) {
        return undefined;
      }
      return { ...principal, scopes: principal.scopes.filter((scope) => !isDemoScope(scope)) };
    },
    close: () => storage.close(),
  };

  if (config.clock.kind === 'system' && config.webhooks.secret === DEV_WEBHOOK_SECRET) {
    logger.warn(
      'WEBHOOK_SECRET is the public development default: set a long random secret shared with the host',
    );
  }
  if (config.demo !== undefined) {
    await registerDemoClinic(
      runtime,
      config.demo.apiKey,
      config.demo.inboxApiKey,
      config.demo.llmMonthlyBudgetUsd,
    );
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
 * integration key, plus `demo:clock` and `demo:ingest` on a fake clock)
 * and, when given, an inbox key with `DEMO_INBOX_API_KEY` (`inbox:read`,
 * `inbox:act`, plus the demo scopes only on a fake clock: never
 * `fhir:write`). Patient contact is enabled so the demo shows
 * `patient_contact.requested` webhooks; the release cap is
 * {@link DEMO_DAILY_CASE_CAP_PER_OWNER}; the escalation policy is
 * {@link DEMO_ESCALATION_POLICY}; every protocol of config/protocols is
 * enabled, drafts included; the nightly reconciliation runs without the
 * weekly full sweep; `llmMonthlyBudgetUsd` (`DEMO_LLM_MONTHLY_BUDGET_USD`)
 * caps a hosted demo's model spend.
 */
export async function registerDemoClinic(
  runtime: EngineRuntime,
  apiKey: string,
  inboxApiKey?: string,
  llmMonthlyBudgetUsd?: number,
): Promise<Clinic> {
  const clinic = await runtime.registerClinic({
    id: DEMO_CLINIC.id,
    name: DEMO_CLINIC.name,
    apiKey,
    settings: {
      allowPatientContact: true,
      timezone: 'America/Caracas',
      // English UI and labels for an international audience; the synthetic
      // notes stay in Spanish and are read as Spanish (docs/adr/0007).
      locale: 'en-US',
      dailyCaseCapPerOwner: DEMO_DAILY_CASE_CAP_PER_OWNER,
      escalationPolicyId: DEMO_ESCALATION_POLICY,
      // The synthetic clinic shows every protocol, drafts included (their
      // reasons carry the draft badge). A real clinic enables a draft only
      // once its clinical team validated it.
      enabledProtocols: [...availableProtocolIds()],
      // The synthetic host sends every patient's AllergyIntolerance list.
      recordCapabilities: ['allergies'],
      // Nightly reconciliation of what changed, no weekly full sweep: the fake
      // clock crosses a week in seconds (a full sweep stays a CLI command).
      reconciliation: { fullSweepWeekday: null },
      ...(llmMonthlyBudgetUsd === undefined ? {} : { llmMonthlyBudgetUsd }),
    },
  });
  if (inboxApiKey !== undefined) {
    await runtime.issueApiKey({
      clinicId: DEMO_CLINIC.id,
      label: DEMO_INBOX_KEY_LABEL,
      scopes: runtime.fakeClock === undefined ? INBOX_SCOPES : [...INBOX_SCOPES, ...DEMO_SCOPES],
      apiKey: inboxApiKey,
    });
  }
  await startDemoShadowPilot(runtime, clinic.id);
  return clinic;
}

/** Ids of every protocol in config/protocols, drafts included (what a clinic may enable). */
export function availableProtocolIds(): readonly string[] {
  return loadConfigDirectory().protocols.map((protocol) => protocol.id);
}

/**
 * A rule's own configuration (config/rules/*.json), unversioned by any
 * clinic override: trigger, how it is fulfilled and superseded, its
 * escalation policy and base version. The engine tests page's "rules are
 * configuration" card reads straight from this, next to
 * {@link EngineRuntime.engine}'s per-clinic `ruleOverrides.list` for the
 * effective (possibly overridden) due date and version.
 */
export function ruleConfigOf(ruleId: string): Rule | undefined {
  return loadConfigDirectory().rules.find((rule) => rule.id === ruleId);
}

/**
 * The demo clinic runs the clinical reviewer's shadow pilot: every
 * implemented category on, in shadow (stored for the clinical team's batch
 * review, never shown to doctors nor sent to the host). Only on first boot:
 * flags someone changed in the demo are kept.
 */
async function startDemoShadowPilot(runtime: EngineRuntime, clinicId: ClinicId): Promise<void> {
  await runtime.storage.unitOfWork.withTransaction(clinicId, async (stores) => {
    if ((await stores.findingFlags.list(clinicId)).length > 0) return;
    for (const flag of shadowPilotFlags(clinicId, 'demo-setup', runtime.clock.now())) {
      await stores.findingFlags.upsert(clinicId, flag);
    }
  });
}

/** The reviewer language of a clinic locale (`es-VE` → `es`); English when it has no copy. */
export function reviewLocaleOf(locale: string | undefined): ReviewLocale {
  const language = primaryLanguage(locale);
  return REVIEW_LOCALES.find((candidate) => candidate === language) ?? DEFAULT_REVIEW_LOCALE;
}

/**
 * Active clinics, for the worker's ambient sweeps (the hourly watcher and
 * escalation pass, and the default scope of `/api/demo/clock/advance`).
 * Lab clinics ({@link isLabClinicId}) are excluded: an evaluator's sandbox
 * only moves when its own "see the impact on a date" preview says so
 * (`engine.runWatcher`/`runEscalation` called directly with the chosen
 * date, scoped to that one clinic), never on the ambient clock's schedule.
 * This is the "clinic-scoped clock" of the evaluator lab (docs/deploy.md#hosted-demo):
 * core's `Clock` port is untouched, and the shared clinic's clock keeps
 * sweeping exactly as before.
 */
export async function activeClinicIds(runtime: EngineRuntime): Promise<readonly ClinicId[]> {
  return (await runtime.storage.clinics.listActive())
    .map((clinic) => clinic.id)
    .filter((id) => !isLabClinicId(id));
}

/** Prefix of a lab clinic's id ({@link labClinicId}). */
export const LAB_CLINIC_PREFIX = 'lab-';

/** Whether `id` is an evaluator's sandbox lab clinic, not a real (or the demo) clinic. */
export function isLabClinicId(id: ClinicId): boolean {
  return id.startsWith(LAB_CLINIC_PREFIX);
}

/**
 * The sandbox clinic id of an evaluator's lab (docs/deploy.md#hosted-demo):
 * deterministic from their email (a sha256 prefix), so the same evaluator
 * always lands on the same, empty, lab clinic and two evaluators never
 * collide.
 */
export function labClinicId(evaluatorEmail: string): ClinicId {
  const hash = createHash('sha256').update(evaluatorEmail.trim().toLowerCase()).digest('hex');
  return toClinicId(`${LAB_CLINIC_PREFIX}${hash.slice(0, 24)}`);
}

/**
 * Registers the evaluator's lab clinic the first time they use it: empty,
 * no patient contact, every protocol enabled (so uploaded documents show
 * every rule the engine can apply), the same escalation policy as the demo
 * clinic. Idempotent: an existing lab clinic is returned unchanged.
 */
export async function ensureLabClinic(
  runtime: EngineRuntime,
  evaluatorEmail: string,
): Promise<Clinic> {
  const id = labClinicId(evaluatorEmail);
  const existing = await runtime.storage.clinics.get(id);
  if (existing !== undefined) {
    return existing;
  }
  return runtime.registerClinic({
    id,
    name: `Lab (${evaluatorEmail})`,
    // Never used to authenticate: lab routes always address this clinic
    // explicitly from the evaluator's signed session, not through an API key.
    apiKey: generateApiKey(),
    settings: {
      allowPatientContact: false,
      locale: 'en-US',
      enabledProtocols: [...availableProtocolIds()],
      escalationPolicyId: DEMO_ESCALATION_POLICY,
      reconciliation: { fullSweepWeekday: null, enabled: false },
    },
  });
}
