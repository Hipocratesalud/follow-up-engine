import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool } from '@follow-up-engine/adapter-postgres';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import type { AppOptions } from '../http/app.ts';
import type { App } from '../http/context.ts';
import { createApiServer } from '../server.ts';

/** Test support: an API over a memory runtime on a fake clock, called in-process. */

export const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../../packages/fhir/fixtures/bundles/${name}.json`, import.meta.url),
    'utf8',
  );

/** Patient of the diabetology fixture (and of the docs/integration.md example). */
export const FIXTURE_PATIENT = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01';
export const KEY_A = 'key-clinic-a';
export const KEY_B = 'key-clinic-b';

export interface CallInit {
  readonly method?: string;
  readonly body?: unknown;
  /** API key; `''` sends no Authorization header. Default {@link KEY_A}. */
  readonly key?: string;
  /** Send `application/fhir+json`. */
  readonly fhir?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CallResult<T> {
  readonly status: number;
  readonly body: T;
  readonly text: string;
  readonly headers: Headers;
}

export interface Harness {
  readonly runtime: EngineRuntime;
  readonly app: App;
  /** Callers name the shape of the JSON body they assert on. */
  call<T>(path: string, init?: CallInit): Promise<CallResult<T>>;
  close(): Promise<void>;
}

/** `DATABASE_URL` of the Postgres runs, or `undefined` (memory only). */
export const TEST_DATABASE_URL =
  process.env['DATABASE_URL'] === '' ? undefined : process.env['DATABASE_URL'];

/** Storages a suite runs on: memory always, Postgres when `DATABASE_URL` is set. */
export const STORAGES: readonly ('memory' | 'postgres')[] =
  TEST_DATABASE_URL === undefined ? ['memory'] : ['memory', 'postgres'];

/**
 * Clinic A is the demo clinic (key {@link KEY_A}); clinic B has {@link KEY_B}.
 * With `storage: 'postgres'` the runtime uses its own throwaway schema.
 */
export async function createHarness(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly app?: Partial<AppOptions>;
    readonly storage?: 'memory' | 'postgres';
  } = {},
): Promise<Harness> {
  const schema =
    options.storage === 'postgres' && TEST_DATABASE_URL !== undefined
      ? `follow_up_api_${randomBytes(5).toString('hex')}`
      : undefined;
  const runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      DEMO_API_KEY: KEY_A,
      ...(schema === undefined
        ? { DATABASE_URL: '' }
        : { DATABASE_URL: TEST_DATABASE_URL ?? '', DATABASE_SCHEMA: schema }),
      ...options.env,
    }),
    { poolSize: 3 },
  );
  await runtime.registerClinic({ id: 'clinic-b', name: 'Clínica B', apiKey: KEY_B });
  const { app } = createApiServer(
    runtime,
    { port: 0, embeddedWorker: false, corsOrigins: [] },
    options.app,
  );
  return {
    runtime,
    app,
    async call<T>(path: string, init: CallInit = {}): Promise<CallResult<T>> {
      const headers: Record<string, string> = { ...init.headers };
      if (init.key !== '') {
        headers['authorization'] = `Bearer ${init.key ?? KEY_A}`;
      }
      if (init.body !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = init.fhir === true ? 'application/fhir+json' : 'application/json';
      }
      const response = await app.request(path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body: body as T, text, headers: response.headers };
    },
    async close() {
      await runtime.close();
      if (schema !== undefined) {
        const pool = createPool({ connectionString: TEST_DATABASE_URL ?? '', max: 1 });
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    },
  };
}
