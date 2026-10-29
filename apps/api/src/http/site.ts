import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { type ApiLocale, messagesFor } from '../i18n/index.ts';
import type { App, AppEnv } from './context.ts';
import { errorResponse } from './errors.ts';
import { HttpError } from './errors.ts';
import { RateLimiter } from './security.ts';

/**
 * A hosted demo on one origin (docs/deploy.md#hosted-demo): the API serves
 * the built inbox next to itself, and an optional shared access code keeps
 * the whole site private. Both are off unless configured: a production API
 * serves JSON and FHIR only.
 */
export interface SiteOptions {
  /** The inbox build (`apps/inbox/dist`), served at `/` with an SPA fallback. */
  readonly inbox?: InboxSite;
  /** The shared code that opens the site (`DEMO_ACCESS_CODE`), 16+ characters. */
  readonly accessCode?: string;
  /** Signs the evaluator identity cookie; derived from `accessCode` when absent. */
  readonly evaluatorSecret?: string;
  /** The UI language a viewer gets until they pick one (`DEFAULT_UI_LOCALE`). */
  readonly defaultLocale: ApiLocale;
}

/** Shortest accepted access code. */
export const MIN_ACCESS_CODE_LENGTH = 16;

/**
 * The HMAC secret the evaluator identity cookie is signed with
 * (docs/deploy.md#evaluator-identity-and-tracking): `DEMO_SESSION_SECRET`
 * when set, else derived from the access code, so a deployment that only
 * ever set the access code keeps working with no new variable.
 */
export function deriveSessionSecret(secretOrAccessCode: string): string {
  return createHmac('sha256', secretOrAccessCode)
    .update('follow-up-engine evaluator session v1')
    .digest('hex');
}

/** Paths that answer without the access code: the platform's health probes and the code page. */
export const ACCESS_PATH = '/_access';
const OPEN_PATHS = new Set(['/healthz', '/readyz', ACCESS_PATH]);

const ACCESS_COOKIE = 'fue_access';
/** Thirty days: the code page is asked once per browser. */
const ACCESS_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Wrong codes per client and minute. */
export const ACCESS_ATTEMPTS_PER_MINUTE = 10;

/**
 * The evaluator's own identity (docs/deploy.md#evaluator-identity-and-tracking):
 * a second cookie next to {@link ACCESS_COOKIE}, collected on the same page.
 * Thirty days, like the access cookie.
 */
const EVALUATOR_COOKIE = 'fue_evaluator';
const EVALUATOR_COOKIE_MAX_AGE_S = ACCESS_COOKIE_MAX_AGE_S;
/** Loose but enough to keep typos and empty values out; the real check is the cookie's signature. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;

/** Paths the API owns: never answered with the inbox. */
const API_PREFIXES = ['/api', '/fhir', '/jobs', '/docs', '/openapi.json', '/healthz', '/readyz'];

/**
 * The cookie value that proves the code: an HMAC keyed by the code, so it
 * survives restarts, needs no session store and stops working when the code
 * changes. The code itself is never stored in the browser.
 */
export function accessToken(code: string): string {
  return createHmac('sha256', code).update('follow-up-engine demo access v1').digest('base64url');
}

function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * The client of a request for the attempt limit: the last `X-Forwarded-For`
 * hop (the one the platform's proxy appended), else the socket peer.
 */
function clientOf(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for');
  const last = forwarded
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  return last ?? 'direct';
}

/** Trimmed, lowercased, and shaped like an email; `undefined` otherwise. */
function normalizeEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email)
    ? email
    : undefined;
}

/**
 * The evaluator cookie's value: the email, readable (base64url, never
 * encrypted — it is not a secret), and an HMAC over it so it cannot be
 * forged or edited in the browser. Replicated by `apps/api/src/lab-records.test.ts`.
 */
function evaluatorToken(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

/** The email a cookie value carries, once its signature checks out against `secret`. */
function parseEvaluatorToken(token: string, secret: string): string | undefined {
  const dot = token.indexOf('.');
  if (dot < 0) return undefined;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let email: string;
  try {
    email = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const expected = createHmac('sha256', secret).update(email).digest('base64url');
  return sameSecret(signature, expected) ? email : undefined;
}

function setEvaluatorCookie(c: Context<AppEnv>, email: string, secret: string): void {
  setCookie(c, EVALUATOR_COOKIE, evaluatorToken(email, secret), {
    path: '/',
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    maxAge: EVALUATOR_COOKIE_MAX_AGE_S,
  });
}

/**
 * The middleware half of the evaluator identity (next to {@link accessGate}):
 * reads the signed `fue_evaluator` cookie and, when it verifies, sets
 * `c.var.evaluatorEmail`. Never blocks by itself — routes that need an
 * evaluator (the lab, the engine tests) check `c.var.evaluatorEmail`
 * themselves, the same way {@link followUpUser} works.
 */
export function evaluatorIdentity(secret: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookie = getCookie(c, EVALUATOR_COOKIE);
    if (cookie !== undefined) {
      const email = parseEvaluatorToken(cookie, secret);
      if (email !== undefined) {
        c.set('evaluatorEmail', email);
      }
    }
    await next();
  };
}

/** A same-site path to return to after the code page; anything else goes home. */
export function safeNextPath(next: string | undefined): string {
  if (next === undefined || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/';
  }
  return next.startsWith(ACCESS_PATH) ? '/' : next;
}

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function accessPage(
  locale: ApiLocale,
  next: string,
  error?: string,
  prefillEmail?: string,
): string {
  const t = messagesFor(locale).accessGate;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(t.title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#111827;--muted:#4b5563;--line:#d1d5db;--accent:#0f766e;--error:#b91c1c}
@media (prefers-color-scheme: dark){:root{--bg:#0b0f14;--card:#141a21;--fg:#f3f4f6;--muted:#9ca3af;--line:#374151;--accent:#2dd4bf;--error:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 20px;color:var(--muted)}
label{display:block;font-weight:600;margin-bottom:6px;margin-top:14px}
label:first-of-type{margin-top:0}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.error{color:var(--error);margin:12px 0 0}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(t.heading)}</h1>
<p>${escapeHtml(t.intro)}</p>
<form method="post" action="${ACCESS_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="email">${escapeHtml(t.emailLabel)}</label>
<input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(prefillEmail ?? '')}" required>
<label for="code">${escapeHtml(t.codeLabel)}</label>
<input id="code" name="code" type="password" autocomplete="current-password" required>
${error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`}
<button type="submit">${escapeHtml(t.submit)}</button>
</form>
</main>
</body>
</html>`;
}

function pageResponse(c: Context<AppEnv>, html: string, status: 200 | 401 | 422 | 429): Response {
  c.header('content-security-policy', PAGE_CSP);
  c.header('cache-control', 'no-store');
  return c.html(html, status);
}

/**
 * The shared access code in front of the whole site, with the evaluator's
 * own email collected on the same page (docs/deploy.md#evaluator-identity-and-tracking).
 * Without the cookies a browser page load goes to the code page and an API
 * call gets 401; the health probes stay open for the platform. The code
 * page sets two HttpOnly cookies, the access one (an HMAC of the code, see
 * {@link accessToken}) and the evaluator one (the email, HMAC'd with
 * `evaluatorSecret`), and returns to the page asked for. Wrong codes are
 * limited per client.
 */
export function registerAccessGate(
  app: App,
  code: string,
  locale: ApiLocale,
  evaluatorSecret: string,
): void {
  const token = accessToken(code);
  const attempts = new RateLimiter();

  app.get(ACCESS_PATH, (c) =>
    pageResponse(c, accessPage(locale, safeNextPath(c.req.query('next'))), 200),
  );
  app.post(ACCESS_PATH, async (c) => {
    const form = await c.req.parseBody();
    const given = typeof form['code'] === 'string' ? form['code'].trim() : '';
    const emailInput = typeof form['email'] === 'string' ? form['email'] : '';
    const next = safeNextPath(typeof form['next'] === 'string' ? form['next'] : undefined);
    const t = messagesFor(locale).accessGate;
    if (!sameSecret(given, code)) {
      const attempt = attempts.take(clientOf(c), ACCESS_ATTEMPTS_PER_MINUTE);
      if (!attempt.ok) {
        c.header('retry-after', String(Math.max(1, attempt.retryAfter)));
        return pageResponse(c, accessPage(locale, next, t.tooManyAttempts, emailInput), 429);
      }
      c.var.log.warn({ alert: 'demo_access_denied' }, 'wrong demo access code');
      return pageResponse(c, accessPage(locale, next, t.wrongCode, emailInput), 401);
    }
    const email = normalizeEmail(emailInput);
    if (email === undefined) {
      return pageResponse(c, accessPage(locale, next, t.invalidEmail, emailInput), 422);
    }
    setCookie(c, ACCESS_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: isSecure(c),
      sameSite: 'Lax',
      maxAge: ACCESS_COOKIE_MAX_AGE_S,
    });
    setEvaluatorCookie(c, email, evaluatorSecret);
    return c.redirect(next, 303);
  });
}

/** The middleware half of {@link registerAccessGate}: mounted before every route. */
export function accessGate(code: string): MiddlewareHandler<AppEnv> {
  const token = accessToken(code);
  return async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) {
      await next();
      return;
    }
    const cookie = getCookie(c, ACCESS_COOKIE);
    if (cookie !== undefined && sameSecret(cookie, token)) {
      await next();
      return;
    }
    const wantsPage =
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      (c.req.header('accept') ?? '').includes('text/html');
    if (wantsPage) {
      const url = new URL(c.req.url);
      return c.redirect(
        `${ACCESS_PATH}?next=${encodeURIComponent(safeNextPath(url.pathname + url.search))}`,
        302,
      );
    }
    return errorResponse(c, new HttpError(401, 'access_required', c.var.t.accessGate.required));
  };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

interface StaticFile {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** The inbox build, read once at startup: no file system access per request, no path traversal. */
export interface InboxSite {
  readonly files: ReadonlyMap<string, StaticFile>;
  readonly index: StaticFile;
  /** The CSP of the inbox pages: its own scripts, the inline theme script by hash, same-origin calls. */
  readonly csp: string;
}

/** The `<meta>` the inbox reads its default UI language from (apps/inbox/src/i18n/locale.ts). */
const LOCALE_META = /<meta name="inbox-default-locale" content="[^"]*"\s*\/?>/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Loads a Vite build of the inbox: every file under `dir`, `index.html`
 * with the deployment's default UI language, and a CSP that allows the
 * inline scripts of `index.html` by hash. Throws when `dir` has no
 * `index.html` (a deployment without its inbox fails at boot, not at the
 * first visit).
 */
export function loadInboxSite(dir: string, defaultLocale: ApiLocale): InboxSite {
  const files = new Map<string, StaticFile>();
  for (const path of walk(dir)) {
    const urlPath = `/${relative(dir, path).split(sep).join('/')}`;
    files.set(urlPath, {
      body: readFileSync(path),
      contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      // Vite fingerprints everything under /assets.
      cacheControl: urlPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
  }
  const indexFile = files.get('/index.html');
  if (indexFile === undefined) {
    throw new Error(`INBOX_DIST_DIR has no index.html: ${dir} (build the inbox first)`);
  }
  const html = new TextDecoder().decode(indexFile.body);
  if (!LOCALE_META.test(html)) {
    throw new Error('the inbox index.html has no inbox-default-locale meta tag');
  }
  const localized = html.replace(
    LOCALE_META,
    `<meta name="inbox-default-locale" content="${defaultLocale}" />`,
  );
  const scriptHashes = [...localized.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, body = '']) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
  );
  const index: StaticFile = {
    body: new TextEncoder().encode(localized),
    contentType: CONTENT_TYPES['.html'] ?? 'text/html',
    cacheControl: 'no-cache',
  };
  files.set('/index.html', index);
  const csp = [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return { files, index, csp };
}

/**
 * The inbox file for a request the API has no route for: the file itself,
 * `index.html` for a client-side route (no extension), `undefined` for API
 * paths, other methods and missing assets (a plain 404).
 */
export function inboxResponse(c: Context<AppEnv>, site: InboxSite): Response | undefined {
  const path = c.req.path;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return undefined;
  if (API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return undefined;
  }
  const file =
    site.files.get(path === '/' ? '/index.html' : path) ??
    (extname(path) === '' ? site.index : undefined);
  if (file === undefined) return undefined;
  c.header('content-type', file.contentType);
  c.header('cache-control', file.cacheControl);
  if (file.contentType.startsWith('text/html')) {
    c.header('content-security-policy', site.csp);
  }
  if (c.req.method === 'HEAD') return c.body(null, 200);
  return c.body(file.body as Uint8Array<ArrayBuffer>, 200);
}
