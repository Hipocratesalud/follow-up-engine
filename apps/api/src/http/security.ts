import { randomUUID } from 'node:crypto';
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
 * `/api/admin/*` (the clinic's rule configuration) → `admin:rules`;
 * `GET /api/demo/clock` → `inbox:read` (the inbox shows the demo date);
 * the demo webhook feed and moving the shared clock → `demo:clock`;
 * saving a demo consultation → `demo:ingest` (and the route only accepts
 * the demo clinic). The demo routes check their scope themselves, so with
 * a real clock they stay a plain 404.
 */
export function requiredScope(method: string, path: string): ApiKeyScope | undefined {
  const read = method === 'GET' || method === 'HEAD';
  if (path === '/fhir' || path.startsWith('/fhir/') || path.startsWith('/jobs/')) {
    return 'fhir:write';
  }
  if (path.startsWith('/api/inbox/')) {
    return read ? 'inbox:read' : 'inbox:act';
  }
  if (path === '/api/admin' || path.startsWith('/api/admin/')) {
    return 'admin:rules';
  }
  if (path.startsWith('/api/demo/')) {
    if (path.startsWith('/api/demo/consultations')) {
      return 'demo:ingest';
    }
    return read && !path.startsWith('/api/demo/webhooks') ? 'inbox:read' : 'demo:clock';
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
      throw new HttpError(403, 'insufficient_scope', c.var.t.errors.insufficientScope(scope));
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

  /** Gives back a token {@link take} took (the request turned out not to count). */
  refund(key: string, perMinute: number): void {
    const bucket = this.#refill(key, perMinute);
    bucket.tokens = Math.min(perMinute, bucket.tokens + 1);
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

export function tooManyRequests(c: Context<AppEnv>, retryAfter: number): HttpError {
  c.header('retry-after', String(Math.max(1, retryAfter)));
  return new HttpError(429, 'rate_limited', c.var.t.errors.rateLimited);
}

/** The client address for failed-authentication limits: the socket peer when known. */
export function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A client-chosen request id: a short token, else the API generates one. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `X-Request-Id` when it is a short token (`[A-Za-z0-9_-]{1,64}`), else a
 * new UUID: clients never write free text into the logs.
 */
export function requestIdOf(c: Context): string {
  const given = c.req.header('x-request-id');
  return given !== undefined && REQUEST_ID.test(given) ? given : randomUUID();
}

/**
 * A header value as text. Node reads header bytes as Latin-1 (one character
 * per byte), so a host that sends UTF-8 ("Médico") arrives as "MÃ©dico":
 * when the bytes are valid UTF-8 they are decoded as such, otherwise they
 * stay Latin-1 (a browser sends "é" as the single byte 0xE9).
 */
export function decodeHeaderText(raw: string): string {
  // eslint-disable-next-line no-control-regex -- every character above Latin-1
  if (/[^\u0000-\u00ff]/.test(raw) || !/[\u0080-\u00ff]/.test(raw)) {
    return raw;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(raw, (char) => char.charCodeAt(0)),
    );
  } catch {
    return raw;
  }
}

/** Longest `X-FollowUp-User`, in characters. */
export const MAX_USER_LENGTH = 120;
/** Letters, marks, digits, punctuation, symbols and plain spaces: no controls, no invisible characters. */
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$/u;

/**
 * The clinic user acting, for the audit trail: `X-FollowUp-User`, decoded
 * as UTF-8, trimmed, at most {@link MAX_USER_LENGTH} printable characters
 * (400 otherwise); `undefined` when absent or blank.
 */
export function followUpUser(c: Context<AppEnv>): string | undefined {
  const raw = c.req.header('x-followup-user');
  if (raw === undefined) {
    return undefined;
  }
  const user = decodeHeaderText(raw).trim();
  if (user === '') {
    return undefined;
  }
  if (Array.from(user).length > MAX_USER_LENGTH || !PRINTABLE.test(user)) {
    throw new HttpError(400, 'invalid_request', c.var.t.errors.invalidUser(MAX_USER_LENGTH));
  }
  return user;
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
