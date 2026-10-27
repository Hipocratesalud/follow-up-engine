import { randomUUID } from 'node:crypto';
import { type EngineRuntime, hashApiKey, type Worker } from '@follow-up-engine/runtime';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import type { App, AppEnv } from './context.ts';
import { registerDemoRoutes } from './demo-routes.ts';
import { errorResponse, HttpError, toHttpError } from './errors.ts';
import { fhirErrorResponse, registerFhirRoutes } from './fhir-routes.ts';
import { registerInboxRoutes } from './inbox-routes.ts';
import { registerJobRoutes } from './job-routes.ts';
import { docsPage, openApiDocument } from './openapi.ts';
import {
  clientAddress,
  DEFAULT_RATE_LIMITS,
  RateLimiter,
  type RateLimits,
  requireScope,
  securityHeaders,
  tooManyRequests,
} from './security.ts';

export interface AppOptions {
  /** Browser origins allowed to call the API (the inbox). */
  readonly corsOrigins: readonly string[];
  /**
   * The worker, when it runs in this process: the demo clock uses it to
   * process jobs and deliver webhooks right after time moves.
   */
  readonly worker?: Worker;
  /** Largest request body accepted, in bytes. Default {@link MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /** Per-key request limits. Default {@link DEFAULT_RATE_LIMITS}. */
  readonly rateLimits?: RateLimits;
}

/**
 * Largest request body: a consultation Bundle is a few KB (a long note with
 * attachments, a few hundred). Larger bodies get 413 before they are parsed.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** C0 controls and DEL: never part of an id, a search value or a path. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * 400 for a path or query value with control characters (`%00`) or broken
 * percent-encoding, before any route or database sees it.
 */
function rejectControlCharacters(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    let values: string[];
    try {
      values = [decodeURIComponent(url.pathname), ...[...url.searchParams].flat()];
    } catch {
      throw new HttpError(400, 'invalid_request', 'La dirección de la petición no es válida.');
    }
    if (values.some((value) => CONTROL_CHARACTER.test(value))) {
      throw new HttpError(
        400,
        'invalid_request',
        'La petición tiene caracteres de control en la dirección o los parámetros.',
      );
    }
    await next();
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * `Authorization: Bearer <api key>` → the clinic and the key's scopes. The
 * clinic never comes from the body. Each key has its own rate limit; failed
 * attempts are limited per client address before any lookup.
 */
function authenticate(
  runtime: EngineRuntime,
  limiter: RateLimiter,
  limits: RateLimits,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    const client = `failed:${clientAddress(c)}`;
    const guessing = limiter.check(client, limits.failedAuthPerMinute);
    if (!guessing.ok) {
      throw tooManyRequests(c, guessing.retryAfter);
    }
    const principal = key === undefined ? undefined : await runtime.authenticate(key);
    if (principal === undefined) {
      limiter.take(client, limits.failedAuthPerMinute);
      throw key === undefined
        ? new HttpError(401, 'unauthorized', 'Falta la clave de API (Authorization: Bearer).')
        : new HttpError(401, 'unauthorized', 'Clave de API no válida.');
    }
    const quota = limiter.take(`key:${hashApiKey(key ?? '')}`, limits.perKeyPerMinute);
    if (!quota.ok) {
      throw tooManyRequests(c, quota.retryAfter);
    }
    c.set('clinic', principal.clinic);
    c.set('clinicId', principal.clinic.id);
    c.set('scopes', principal.scopes);
    c.set('log', c.var.log.child({ clinicId: principal.clinic.id }));
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
  app.use('*', securityHeaders());
  app.use('*', rejectControlCharacters());
  app.use(
    '*',
    bodyLimit({
      maxSize: options.maxBodyBytes ?? MAX_BODY_BYTES,
      onError: () => {
        throw new HttpError(
          413,
          'payload_too_large',
          `El cuerpo supera el máximo de ${String(Math.floor((options.maxBodyBytes ?? MAX_BODY_BYTES) / 1024))} KB.`,
        );
      },
    }),
  );
  app.use(
    '*',
    cors({
      origin: [...options.corsOrigins],
      allowHeaders: ['Authorization', 'Content-Type', 'Prefer', 'X-Request-Id', 'X-FollowUp-User'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      exposeHeaders: [
        'X-Request-Id',
        'X-FollowUp-Job',
        'X-FollowUp-Summary',
        'Location',
        'Content-Location',
        'ETag',
        'Retry-After',
      ],
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

  // `/fhir/*` also matches `/fhir`: one authentication per request. The
  // CapabilityStatement is public (FHIR clients read it before they log in).
  const auth = authenticate(runtime, new RateLimiter(), options.rateLimits ?? DEFAULT_RATE_LIMITS);
  const fhirAuth: MiddlewareHandler<AppEnv> = (c, next) =>
    c.req.path === '/fhir/metadata' ? next() : auth(c, next);
  const scoped = requireScope();
  const fhirScoped: MiddlewareHandler<AppEnv> = (c, next) =>
    c.req.path === '/fhir/metadata' ? next() : scoped(c, next);
  app.use('/fhir/*', fhirAuth, fhirScoped);
  app.use('/api/*', auth, scoped);
  app.use('/jobs/*', auth, scoped);

  registerFhirRoutes(app, runtime);
  registerJobRoutes(app, runtime);
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
