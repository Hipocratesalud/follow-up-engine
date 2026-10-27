import { z } from 'zod';

/** Default start of the fake clock: the end of the synthetic clinic's history (testkit `BASE_DATE`). */
export const DEFAULT_FAKE_CLOCK_START = '2026-01-05T12:00:00.000Z';

/** Secret the in-process webhook loopback signs with when `WEBHOOK_SECRET` is unset (demo only). */
export const DEV_WEBHOOK_SECRET = 'dev-only-webhook-secret';

/** Default demo keys, printed in the README: never accepted on a real clock. */
export const DEFAULT_DEMO_API_KEY = 'demo-clinic-key';
export const DEFAULT_DEMO_INBOX_API_KEY = 'demo-inbox-key';
export const PUBLIC_DEMO_KEYS: readonly string[] = [
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
];

/**
 * Shortest demo key accepted with `CLOCK=system` and `DEMO_CLINIC=true`,
 * in the environment and when a stored demo key authenticates.
 */
export const MIN_PRODUCTION_KEY_LENGTH = 24;

export const LLM_PROVIDERS = ['fake', 'meta', 'baseten', 'openai-compatible'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const positiveInt = (fallback: number): z.ZodType<number> =>
  z.coerce.number().int().positive().optional().default(fallback);

/**
 * Environment of the engine runtime (API and worker). Parsed once at boot;
 * an invalid value fails fast with every problem listed. See `.env.example`.
 */
const EnvSchema = z
  .object({
    DATABASE_URL: optionalString,
    /** Postgres schema of the engine tables. Default `follow_up`. */
    DATABASE_SCHEMA: optionalString,
    CLOCK: z.enum(['system', 'fake']).optional().default('system'),
    FAKE_CLOCK_START: z.iso.datetime({ offset: true }).optional().default(DEFAULT_FAKE_CLOCK_START),
    /**
     * Default: `meta` (Muse Spark) when `META_API_KEY` is set, else `fake`;
     * always `fake` in CI (`CI` set) unless named here.
     */
    LLM_PROVIDER: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(LLM_PROVIDERS).optional(),
    ),
    CI: optionalString,
    META_API_KEY: optionalString,
    META_MODEL: optionalString,
    BASETEN_API_KEY: optionalString,
    BASETEN_MODEL: optionalString,
    OPENAI_COMPATIBLE_BASE_URL: optionalString,
    OPENAI_COMPATIBLE_API_KEY: optionalString,
    OPENAI_COMPATIBLE_MODEL: optionalString,
    /** USD per 1M tokens, so the gateway can account and cap an unlisted model. */
    OPENAI_COMPATIBLE_PRICE_IN_PER_MTOK: z.coerce.number().nonnegative().optional().default(0),
    OPENAI_COMPATIBLE_PRICE_OUT_PER_MTOK: z.coerce.number().nonnegative().optional().default(0),
    /** Host endpoint that receives signed webhooks. Unset: delivered to the in-process sink (demo). */
    WEBHOOK_URL: optionalString,
    WEBHOOK_SECRET: optionalString,
    /** Where the API reads demo webhook deliveries from when the sink runs as its own service. */
    WEBHOOK_SINK_URL: optionalString,
    /**
     * API key of the demo clinic `clinic-demo` (host integration scopes);
     * registered at boot on a fake clock, or with `DEMO_CLINIC=true`.
     */
    DEMO_API_KEY: optionalString,
    /**
     * Inbox key of the demo clinic (`inbox:read`, `inbox:act`; plus
     * `demo:clock` and `demo:ingest` on a fake clock): `VITE_API_KEY`.
     */
    DEMO_INBOX_API_KEY: optionalString,
    /**
     * Monthly LLM budget of the demo clinic, in USD (default: the clinic
     * default). A hosted demo caps what public traffic can spend on live calls.
     */
    DEMO_LLM_MONTHLY_BUDGET_USD: z.coerce.number().positive().optional(),
    /** Register the demo clinic with `CLOCK=system` too (its keys must not be the public ones). */
    DEMO_CLINIC: z
      .enum(['true', 'false', '1', '0', ''])
      .optional()
      .transform((value) => value === 'true' || value === '1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .optional()
      .default('info'),
    WORKER_POLL_MS: positiveInt(1_000),
    OUTBOX_POLL_MS: positiveInt(2_000),
    SWEEP_INTERVAL_MS: positiveInt(3_600_000),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'meta' && env.META_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['META_API_KEY'],
        message: 'required by LLM_PROVIDER=meta',
      });
    }
    if (env.LLM_PROVIDER === 'baseten' && env.BASETEN_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['BASETEN_API_KEY'],
        message: 'required by LLM_PROVIDER=baseten',
      });
    }
    if (env.LLM_PROVIDER === 'openai-compatible') {
      for (const key of [
        'OPENAI_COMPATIBLE_BASE_URL',
        'OPENAI_COMPATIBLE_API_KEY',
        'OPENAI_COMPATIBLE_MODEL',
      ] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required by LLM_PROVIDER=openai-compatible',
          });
        }
      }
    }
    if (env.CLOCK === 'system' && env.DEMO_CLINIC) {
      for (const key of ['DEMO_API_KEY', 'DEMO_INBOX_API_KEY'] as const) {
        const value = env[key];
        if (
          value !== undefined &&
          (PUBLIC_DEMO_KEYS.includes(value) || value.length < MIN_PRODUCTION_KEY_LENGTH)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `with CLOCK=system it must be a private key of at least ${String(MIN_PRODUCTION_KEY_LENGTH)} characters, not a published default`,
          });
        }
      }
    }
    if (env.WEBHOOK_URL !== undefined && env.WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: 'required when WEBHOOK_URL is set',
      });
    }
  });

export interface LlmConfig {
  readonly provider: LlmProviderName;
  readonly metaApiKey?: string;
  readonly metaModel?: string;
  readonly basetenApiKey?: string;
  readonly basetenModel?: string;
  readonly openAiCompatible?: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly priceInPerMTok: number;
    readonly priceOutPerMTok: number;
  };
}

export interface WebhookConfig {
  /** Unset: events go to the in-process sink, signed with {@link secret}. */
  readonly url?: string;
  readonly secret: string;
  readonly sinkUrl?: string;
}

/** Typed runtime configuration, built from the environment by {@link loadRuntimeConfig}. */
export interface RuntimeConfig {
  readonly databaseUrl?: string;
  readonly databaseSchema?: string;
  readonly clock: { readonly kind: 'system' } | { readonly kind: 'fake'; readonly start: Date };
  readonly llm: LlmConfig;
  readonly webhooks: WebhookConfig;
  /**
   * The demo clinic to register: on a fake clock whenever `DEMO_API_KEY` is
   * set; on a real clock only with `DEMO_CLINIC=true`.
   */
  readonly demo?: {
    readonly apiKey: string;
    readonly inboxApiKey?: string;
    /** `DEMO_LLM_MONTHLY_BUDGET_USD`. */
    readonly llmMonthlyBudgetUsd?: number;
  };
  /** `DEMO_API_KEY` was set on a real clock without `DEMO_CLINIC=true` (logged, ignored). */
  readonly ignoredDemoApiKey: boolean;
  readonly logLevel: string;
  readonly worker: {
    readonly pollMs: number;
    readonly outboxPollMs: number;
    readonly sweepIntervalMs: number;
  };
}

/** Raised when the environment is invalid; the message lists every problem. */
export class InvalidConfigError extends Error {
  override readonly name = 'InvalidConfigError';
}

/** `{ [key]: value }`, or `{}` when the value is absent (for `exactOptionalPropertyTypes`). */
export function defined<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Partial<Record<TKey, TValue>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<TKey, TValue>>;
}

/** Reads and validates the runtime configuration from `env` (default `process.env`). */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`,
    );
    throw new InvalidConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  const e = parsed.data;
  const ci = e.CI !== undefined && e.CI !== 'false' && e.CI !== '0';
  const provider: LlmProviderName =
    e.LLM_PROVIDER ?? (e.META_API_KEY !== undefined && !ci ? 'meta' : 'fake');
  const openAiCompatible =
    e.OPENAI_COMPATIBLE_BASE_URL !== undefined &&
    e.OPENAI_COMPATIBLE_API_KEY !== undefined &&
    e.OPENAI_COMPATIBLE_MODEL !== undefined
      ? {
          openAiCompatible: {
            baseUrl: e.OPENAI_COMPATIBLE_BASE_URL,
            apiKey: e.OPENAI_COMPATIBLE_API_KEY,
            model: e.OPENAI_COMPATIBLE_MODEL,
            priceInPerMTok: e.OPENAI_COMPATIBLE_PRICE_IN_PER_MTOK,
            priceOutPerMTok: e.OPENAI_COMPATIBLE_PRICE_OUT_PER_MTOK,
          },
        }
      : {};
  return {
    ...defined('databaseUrl', e.DATABASE_URL),
    ...defined('databaseSchema', e.DATABASE_SCHEMA),
    clock:
      e.CLOCK === 'fake'
        ? { kind: 'fake', start: new Date(e.FAKE_CLOCK_START) }
        : { kind: 'system' },
    llm: {
      provider,
      ...defined('metaApiKey', e.META_API_KEY),
      ...defined('metaModel', e.META_MODEL),
      ...defined('basetenApiKey', e.BASETEN_API_KEY),
      ...defined('basetenModel', e.BASETEN_MODEL),
      ...openAiCompatible,
    },
    webhooks: {
      secret: e.WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET,
      ...defined('url', e.WEBHOOK_URL),
      ...defined('sinkUrl', e.WEBHOOK_SINK_URL),
    },
    ...(e.DEMO_API_KEY !== undefined && (e.CLOCK === 'fake' || e.DEMO_CLINIC)
      ? {
          demo: {
            apiKey: e.DEMO_API_KEY,
            ...defined('inboxApiKey', e.DEMO_INBOX_API_KEY),
            ...defined('llmMonthlyBudgetUsd', e.DEMO_LLM_MONTHLY_BUDGET_USD),
          },
        }
      : {}),
    ignoredDemoApiKey: e.DEMO_API_KEY !== undefined && e.CLOCK === 'system' && !e.DEMO_CLINIC,
    logLevel: e.LOG_LEVEL,
    worker: {
      pollMs: e.WORKER_POLL_MS,
      outboxPollMs: e.OUTBOX_POLL_MS,
      sweepIntervalMs: e.SWEEP_INTERVAL_MS,
    },
  };
}
