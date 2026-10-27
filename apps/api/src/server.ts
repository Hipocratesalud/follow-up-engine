import { type ServerType, serve } from '@hono/node-server';
import { type EngineRuntime, Worker } from '@follow-up-engine/runtime';
import type { ApiConfig } from './config.ts';
import { type AppOptions, createApp } from './http/app.ts';
import type { App } from './http/context.ts';
import { loadInboxSite } from './http/site.ts';
import { DEFAULT_API_LOCALE } from './i18n/index.ts';

export interface ApiServer {
  readonly app: App;
  /** The in-process worker, when `EMBEDDED_WORKER=true`. */
  readonly worker?: Worker;
  /** Resolves with the bound port once listening. */
  listen(port?: number): Promise<number>;
  /** Stops accepting requests, drains the worker, closes storage. */
  close(): Promise<void>;
}

/**
 * Wires the HTTP app on a runtime and, with `embeddedWorker`, starts the
 * worker loops in the same process (single-container deployments, demo).
 * `appOptions` overrides HTTP tuning (tests).
 */
export function createApiServer(
  runtime: EngineRuntime,
  config: ApiConfig,
  appOptions: Partial<AppOptions> = {},
): ApiServer {
  const worker = config.embeddedWorker ? new Worker(runtime) : undefined;
  const defaultLocale = config.defaultUiLocale ?? DEFAULT_API_LOCALE;
  const site =
    config.inboxDistDir === undefined && config.accessCode === undefined
      ? undefined
      : {
          defaultLocale,
          ...(config.inboxDistDir === undefined
            ? {}
            : { inbox: loadInboxSite(config.inboxDistDir, defaultLocale) }),
          ...(config.accessCode === undefined ? {} : { accessCode: config.accessCode }),
        };
  const app = createApp(runtime, {
    ...appOptions,
    corsOrigins: config.corsOrigins,
    ...(worker === undefined ? {} : { worker }),
    ...(site === undefined ? {} : { site }),
  });
  let server: ServerType | undefined;
  return {
    app,
    ...(worker === undefined ? {} : { worker }),
    listen(port = config.port) {
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, port }, (info) => {
          runtime.logger.info(
            { port: info.port, embeddedWorker: worker !== undefined },
            'api listening',
          );
          resolve(info.port);
        });
        worker?.start();
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        if (server === undefined) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
      await worker?.stop();
      await runtime.close();
    },
  };
}
