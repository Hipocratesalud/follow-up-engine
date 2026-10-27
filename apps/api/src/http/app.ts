import { randomUUID } from 'node:crypto';
import { type EngineRuntime, hashApiKey, type Worker } from '@follow-up-engine/runtime';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import type { App, AppEnv } from './context.ts';
import { registerDemoRoutes } from './demo-routes.ts';
import { errorResponse, HttpError, toHttpError } from './errors.ts';
import { fhirErrorResponse, registerFhirRoutes } from './fhir-routes.ts';
import { registerInboxRoutes } from './inbox-routes.ts';
import { docsPage, openApiDocument } from './openapi.ts';

export interface AppOptions {
  /** Browser origins allowed to call the API (the inbox). */
  readonly corsOrigins: readonly string[];
  /**
   * The worker, when it runs in this process: the demo clock uses it to
   * process jobs and deliver webhooks right after time moves.
   */
  readonly worker?: Worker;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** `Authorization: Bearer <api key>` → the clinic. The clinic never comes from the body. */
function authenticate(runtime: EngineRuntime): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (key === undefined) {
      throw new HttpError(401, 'unauthorized', 'Falta la clave de API (Authorization: Bearer).');
    }
    const clinic = await runtime.storage.clinics.findByApiKeyHash(hashApiKey(key));
    if (clinic?.active !== true) {
      throw new HttpError(401, 'unauthorized', 'Clave de API no válida.');
    }
    c.set('clinic', clinic);
    c.set('clinicId', clinic.id);
    c.set('log', c.var.log.child({ clinicId: clinic.id }));
    await next();
  };
}

/** Access log: method, route, status, duration and clinic. Never bodies or query values. */
function accessLog(runtime: EngineRuntime): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    const log = runtime.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    const started = performance.now();
    await next();
    c.header('x-request-id', requestId);
    const level = c.res.status >= 500 ? 'error' : 'info';
    c.var.log[level](
      {
        method: c.req.method,
        path: routePath(c),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  };
}

/**
 * The HTTP API: FHIR R4 (`/fhir`), the clinic inbox (`/api/inbox`), the
 * demo controls (`/api/demo`, only with a fake clock), health probes and the
 * OpenAPI document. A plain Hono app: it runs on Node through
 * `@hono/node-server` and is tested in-process with `app.request()`.
 */
export function createApp(runtime: EngineRuntime, options: AppOptions): App {
  const app = new Hono<AppEnv>();

  app.use('*', accessLog(runtime));
  app.use(
    '*',
    cors({
      origin: [...options.corsOrigins],
      allowHeaders: ['Authorization', 'Content-Type', 'Prefer', 'X-Request-Id', 'X-FollowUp-User'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id', 'X-FollowUp-Job', 'Location'],
      maxAge: 600,
    }),
  );

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await runtime.storage.ping();
      return c.json({ status: 'ready', storage: runtime.storage.kind });
    } catch {
      return c.json({ status: 'unavailable', storage: runtime.storage.kind }, 503);
    }
  });
  app.get('/openapi.json', (c) =>
    c.json(openApiDocument({ demo: runtime.fakeClock !== undefined })),
  );
  app.get('/docs', (c) => c.html(docsPage()));

  app.use('/fhir/*', authenticate(runtime));
  app.use('/fhir', authenticate(runtime));
  app.use('/api/*', authenticate(runtime));

  registerFhirRoutes(app, runtime);
  registerInboxRoutes(app, runtime);
  if (runtime.fakeClock !== undefined) {
    registerDemoRoutes(app, runtime, runtime.fakeClock, options.worker);
  }

  app.notFound((c) => {
    const error = new HttpError(404, 'not_found', 'Ruta no encontrada.');
    return c.req.path.startsWith('/fhir') ? fhirErrorResponse(c, error) : errorResponse(c, error);
  });
  app.onError((error, c) => {
    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      c.var.log.error(
        { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        'unhandled error',
      );
    }
    return c.req.path.startsWith('/fhir')
      ? fhirErrorResponse(c, httpError)
      : errorResponse(c, httpError);
  });
  return app;
}
