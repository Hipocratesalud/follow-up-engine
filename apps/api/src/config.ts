import { z } from 'zod';

/** HTTP-specific configuration; the engine runtime reads its own (see `@follow-up-engine/worker`). */
export interface ApiConfig {
  readonly port: number;
  /** Run the background worker inside the API process (single-container deployments, demo). */
  readonly embeddedWorker: boolean;
  /** Browser origins allowed to call the API (the inbox). */
  readonly corsOrigins: readonly string[];
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
  };
}
