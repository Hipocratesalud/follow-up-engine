import { z } from 'zod';

/** Default start of the fake clock: the end of the synthetic clinic's history (testkit `BASE_DATE`). */
export const DEFAULT_FAKE_CLOCK_START = '2026-01-05T12:00:00.000Z';

/** Secret the in-process webhook loopback signs with when `WEBHOOK_SECRET` is unset (demo only). */
export const DEV_WEBHOOK_SECRET = 'dev-only-webhook-secret';

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
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).optional().default('fake'),
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
    /** API key of the demo clinic `clinic-demo`; registered at boot when set. */
    DEMO_API_KEY: optionalString,
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
  readonly demoApiKey?: string;
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
      provider: e.LLM_PROVIDER,
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
    ...defined('demoApiKey', e.DEMO_API_KEY),
    logLevel: e.LOG_LEVEL,
    worker: {
      pollMs: e.WORKER_POLL_MS,
      outboxPollMs: e.OUTBOX_POLL_MS,
      sweepIntervalMs: e.SWEEP_INTERVAL_MS,
    },
  };
}
