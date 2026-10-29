import { z } from 'zod';
import { API_LOCALES, type ApiLocale, DEFAULT_API_LOCALE } from './i18n/index.ts';
import { MIN_ACCESS_CODE_LENGTH } from './http/site.ts';

/** HTTP-specific configuration; the engine runtime reads its own (see `@follow-up-engine/runtime`). */
export interface ApiConfig {
  readonly port: number;
  /** Run the background worker inside the API process (single-container deployments, demo). */
  readonly embeddedWorker: boolean;
  /** Browser origins allowed to call the API (the inbox). */
  readonly corsOrigins: readonly string[];
  /** The inbox build to serve on the API's origin (`INBOX_DIST_DIR`, hosted demo). */
  readonly inboxDistDir?: string;
  /** Shared code in front of the whole site (`DEMO_ACCESS_CODE`, hosted demo). */
  readonly accessCode?: string;
  /**
   * Secret that signs the evaluator identity cookie (`DEMO_SESSION_SECRET`).
   * Without it, derived from `DEMO_ACCESS_CODE` so an existing deployment
   * keeps working with no new variable to set.
   */
  readonly sessionSecret?: string;
  /** The UI language a viewer of the hosted inbox gets until they pick one (`DEFAULT_UI_LOCALE`, default English). */
  readonly defaultUiLocale?: ApiLocale;
}

const ApiEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).optional().default(3000),
  EMBEDDED_WORKER: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  CORS_ORIGINS: z
    .string()
    .optional()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    ),
  INBOX_DIST_DIR: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  DEMO_ACCESS_CODE: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value))
    .refine((value) => value === undefined || value.length >= MIN_ACCESS_CODE_LENGTH, {
      message: `must be at least ${String(MIN_ACCESS_CODE_LENGTH)} characters`,
    }),
  DEMO_SESSION_SECRET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  DEFAULT_UI_LOCALE: z.enum(API_LOCALES).optional().default(DEFAULT_API_LOCALE),
});

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = ApiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid API configuration:\n- ${problems.join('\n- ')}`);
  }
  return {
    port: parsed.data.PORT,
    embeddedWorker: parsed.data.EMBEDDED_WORKER,
    corsOrigins: parsed.data.CORS_ORIGINS,
    ...(parsed.data.INBOX_DIST_DIR === undefined
      ? {}
      : { inboxDistDir: parsed.data.INBOX_DIST_DIR }),
    ...(parsed.data.DEMO_ACCESS_CODE === undefined
      ? {}
      : { accessCode: parsed.data.DEMO_ACCESS_CODE }),
    ...(parsed.data.DEMO_SESSION_SECRET === undefined
      ? {}
      : { sessionSecret: parsed.data.DEMO_SESSION_SECRET }),
    defaultUiLocale: parsed.data.DEFAULT_UI_LOCALE,
  };
}
