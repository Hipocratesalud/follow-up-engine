import { getConnInfo } from '@hono/node-server/conninfo';
import type { ApiKeyScope } from '@follow-up-engine/runtime';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.ts';
import { HttpError } from './errors.ts';
import { DOCS_UI_SCRIPT } from './openapi.ts';

/**
 * The scope a request needs, from its method and path:
 * `/fhir/*` and `/jobs/*` → `fhir:write` (the host integration);
 * `GET /api/inbox/*` → `inbox:read`, other methods → `inbox:act`;
 * `GET /api/demo/*` → `inbox:read` (the inbox shows the demo clock and
 * webhooks), other methods → `demo` (moving the shared clock, demo
 * consultations). The demo routes check their scope themselves, so with a
 * real clock they stay a plain 404.
 */
export function requiredScope(method: string, path: string): ApiKeyScope | undefined {
  const read = method === 'GET' || method === 'HEAD';
  if (path === '/fhir' || path.startsWith('/fhir/') || path.startsWith('/jobs/')) {
    return 'fhir:write';
  }
  if (path.startsWith('/api/inbox/')) {
    return read ? 'inbox:read' : 'inbox:act';
  }
  if (path.startsWith('/api/demo/')) {
    return read ? 'inbox:read' : 'demo';
  }
  return undefined;
}

/** 403 unless the authenticated key has the scope the route needs. */
export function requireScope(
  options: { readonly demoRoutes?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const scope = requiredScope(c.req.method, c.req.path);
    if (scope !== undefined && c.req.path.startsWith('/api/demo/') && options.demoRoutes !== true) {
      await next();
      return;
    }
    if (scope !== undefined && !c.var.scopes.includes(scope)) {
      throw new HttpError(
        403,
        'insufficient_scope',
        `La clave de API no tiene el permiso "${scope}" que necesita esta operación.`,
      );
    }
    await next();
  };
}

/** Requests per minute and per key (or per client for failed authentications). */
export interface RateLimits {
  /** Authenticated requests per API key per minute. */
  readonly perKeyPerMinute: number;
  /** Requests with a missing or wrong key per client address per minute. */
  readonly failedAuthPerMinute: number;
}

/**
 * Generous for an EHR integration or an inbox (10 requests per second, per
 * key), small for guessing keys.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  perKeyPerMinute: 600,
  failedAuthPerMinute: 60,
};

const WINDOW_MS = 60_000;
/** Buckets idle this long are dropped, so the map does not grow without bound. */
const IDLE_MS = 10 * WINDOW_MS;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per key, in process memory: each process enforces its own
 * limit (behind several API replicas the effective limit multiplies; put a
 * shared limiter in the gateway for that).
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  #sweptAt: number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#sweptAt = now();
  }

  /** Takes one token; returns the seconds to wait when the bucket is empty. */
  take(key: string, perMinute: number): { readonly ok: boolean; readonly retryAfter: number } {
    const bucket = this.#refill(key, perMinute);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.ceil(((1 - bucket.tokens) / perMinute) * 60) };
  }

  /** Like {@link take} without taking: whether a request would be refused now. */
  check(key: string, perMinute: number): { readonly ok: boolean; readonly retryAfter: number } {
    const bucket = this.#refill(key, perMinute);
    return bucket.tokens >= 1
      ? { ok: true, retryAfter: 0 }
      : { ok: false, retryAfter: Math.ceil(((1 - bucket.tokens) / perMinute) * 60) };
  }

  #refill(key: string, perMinute: number): Bucket {
    const now = this.#now();
    this.#sweep(now);
    const bucket = this.#buckets.get(key) ?? { tokens: perMinute, updatedAt: now };
    bucket.tokens = Math.min(
      perMinute,
      bucket.tokens + ((now - bucket.updatedAt) / WINDOW_MS) * perMinute,
    );
    bucket.updatedAt = now;
    this.#buckets.set(key, bucket);
    return bucket;
  }

  #sweep(now: number): void {
    if (now - this.#sweptAt < WINDOW_MS) {
      return;
    }
    this.#sweptAt = now;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt > IDLE_MS) {
        this.#buckets.delete(key);
      }
    }
  }
}

export function tooManyRequests(c: Context, retryAfter: number): HttpError {
  c.header('retry-after', String(Math.max(1, retryAfter)));
  return new HttpError(
    429,
    'rate_limited',
    'Demasiadas peticiones. Intenta de nuevo en unos segundos.',
  );
}

/** The client address for failed-authentication limits: the socket peer when known. */
export function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Content-Security-Policy of the JSON and FHIR API: nothing to load, not framable. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** The API reference UI (`/docs`): the pinned Scalar bundle, its styles and fonts, same-origin calls. */
export const DOCS_CSP = [
  "default-src 'none'",
  `script-src 'self' ${DOCS_UI_SCRIPT.url}`,
  "style-src 'self' 'unsafe-inline' https://fonts.scalar.com",
  "font-src 'self' data: https://fonts.scalar.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Helmet-equivalent headers on every response: no MIME sniffing, no
 * framing, no referrer, no cross-origin embedding of responses, and a CSP
 * that allows nothing (the `/docs` page gets {@link DOCS_CSP}).
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', 'same-site');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(c.req.url).protocol === 'https:') {
      c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    c.header('content-security-policy', c.req.path === '/docs' ? DOCS_CSP : API_CSP);
  };
}
