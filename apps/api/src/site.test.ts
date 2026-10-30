import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import {
  ACCESS_ATTEMPTS_PER_MINUTE,
  accessToken,
  deriveSessionSecret,
  safeNextPath,
} from './http/site.ts';
import { createApiServer } from './server.ts';

const KEY = 'site-test-clinic-key';
const CODE = 'correct-horse-battery-staple';
const EMAIL = 'doctor@example.com';

/** Replicates `site.ts`'s private evaluator cookie signing. */
function evaluatorCookie(email: string, code: string): string {
  const secret = deriveSessionSecret(code);
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta name="inbox-default-locale" content="en" />
    <script>
      document.documentElement.dataset.theme = 'light';
    </script>
  </head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body>
</html>`;

let dist: string;
let runtime: EngineRuntime | undefined;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'inbox-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log("inbox");');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function site(env: Record<string, string>): Promise<App> {
  runtime = await createRuntime(
    loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: KEY }),
  );
  const config = loadApiConfig(env);
  return createApiServer(runtime, config).app;
}

const html = { accept: 'text/html,application/xhtml+xml' };
const cookie = {
  cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EMAIL, CODE)}`,
};

describe('hosted inbox on the API origin', () => {
  it('serves the inbox with its default language, an SPA fallback and its own CSP', async () => {
    const app = await site({ INBOX_DIST_DIR: dist, DEFAULT_UI_LOCALE: 'es' });
    const page = await app.request('/', { headers: html });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const body = await page.text();
    expect(body).toContain('<meta name="inbox-default-locale" content="es" />');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // A client-side route gets index.html; a fingerprinted asset is cached for good.
    const route = await app.request('/inbox/case-001', { headers: html });
    expect(route.status).toBe(200);
    expect(await route.text()).toBe(body);
    const asset = await app.request('/assets/index-abc.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe('console.log("inbox");');
    expect((await app.request('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
    expect((await app.request('/assets/missing.js')).status).toBe(404);
  });

  it('keeps the API answering JSON: unknown API paths stay a JSON 404 with the API CSP', async () => {
    const app = await site({ INBOX_DIST_DIR: dist });
    const unknown = await app.request('/api/nope', { headers: { authorization: `Bearer ${KEY}` } });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect(unknown.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    const fhir = await app.request('/fhir/Nope', { headers: { authorization: `Bearer ${KEY}` } });
    expect(fhir.headers.get('content-type')).toContain('json');
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('defaults to English and serves no inbox unless configured', async () => {
    const plain = await site({});
    expect((await plain.request('/', { headers: html })).status).toBe(404);
    const english = await site({ INBOX_DIST_DIR: dist });
    expect(await (await english.request('/')).text()).toContain('content="en"');
  });

  it('refuses a build without index.html at boot', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'inbox-empty-'));
    try {
      await expect(site({ INBOX_DIST_DIR: empty })).rejects.toThrow(/index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('shared access code', () => {
  it('rejects a code shorter than 16 characters', () => {
    expect(() => loadApiConfig({ DEMO_ACCESS_CODE: 'short' })).toThrow(/DEMO_ACCESS_CODE/);
  });

  it('sends a page load to the code page and an API call to a 401; health stays open', async () => {
    const app = await site({ INBOX_DIST_DIR: dist, DEMO_ACCESS_CODE: CODE });
    const page = await app.request('/inbox?status=open', { headers: html });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(
      `/_access?next=${encodeURIComponent('/inbox?status=open')}`,
    );
    const api = await app.request('/api/inbox/cases', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(api.status).toBe(401);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('access_required');
    for (const path of ['/docs', '/openapi.json', '/fhir/metadata', '/assets/index-abc.js']) {
      expect((await app.request(path)).status, path).toBe(401);
    }
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it("shows the code page in the browser's language, whatever DEFAULT_UI_LOCALE says", async () => {
    const app = await site({ DEMO_ACCESS_CODE: CODE, DEFAULT_UI_LOCALE: 'en' });
    const page = await app.request('/_access?next=/metrics', {
      headers: { 'accept-language': 'es-VE,es;q=0.9,en;q=0.5' },
    });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<html lang="es">');
    expect(body).toContain('Código de acceso');
    expect(body).toContain('name="next" value="/metrics"');
    expect(body).toContain('name="lang" value="es"');
    expect(page.headers.get('vary')).toContain('Accept-Language');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(page.headers.get('cache-control')).toBe('no-store');

    // DEFAULT_UI_LOCALE=es does not make an English browser read Spanish, nor a browser with no preference.
    const spanishDefault = await site({ DEMO_ACCESS_CODE: CODE, DEFAULT_UI_LOCALE: 'es' });
    const english = await (
      await spanishDefault.request('/_access', { headers: { 'accept-language': 'en-US,en' } })
    ).text();
    expect(english).toContain('<html lang="en">');
    expect(english).toContain('Access code');
    expect(english).not.toContain('Código de acceso');
    expect(await (await spanishDefault.request('/_access')).text()).toContain('Access code');
  });

  it('has an EN / ES switch that keeps the page asked for and wins over the browser', async () => {
    const app = await site({ DEMO_ACCESS_CODE: CODE });
    const english = await (
      await app.request('/_access?next=/lab', { headers: { 'accept-language': 'es' } })
    ).text();
    expect(english).toContain(
      '<a href="/_access?lang=en&amp;next=%2Flab" hreflang="en" lang="en">EN</a>',
    );
    expect(english).toContain(
      '<a href="/_access?lang=es&amp;next=%2Flab" hreflang="es" lang="es" aria-current="true">ES</a>',
    );
    expect(english).toContain('aria-label="Idioma"');

    const switched = await (
      await app.request('/_access?lang=en&next=/lab', { headers: { 'accept-language': 'es' } })
    ).text();
    expect(switched).toContain('<html lang="en">');
    expect(switched).toContain('name="next" value="/lab"');
    expect(switched).toContain('aria-label="Language"');

    // The choice travels with the form: an error comes back in the same language.
    const wrong = await app.request('/_access', {
      method: 'POST',
      headers: { 'accept-language': 'en' },
      body: new URLSearchParams({ code: 'not-the-code', email: EMAIL, next: '/lab', lang: 'es' }),
    });
    expect(wrong.status).toBe(401);
    const body = await wrong.text();
    expect(body).toContain('Ese código no es válido');
    expect(body).toContain('name="lang" value="es"');
  });

  it('lets the right code in with an HttpOnly cookie and returns to the page asked for', async () => {
    const app = await site({ INBOX_DIST_DIR: dist, DEMO_ACCESS_CODE: CODE });
    const wrong = await app.request('/_access', {
      method: 'POST',
      body: new URLSearchParams({ code: 'not-the-code', next: '/metrics' }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(await wrong.text()).toContain('not valid');

    const right = await app.request('https://demo.example/_access', {
      method: 'POST',
      body: new URLSearchParams({ code: ` ${CODE} `, email: EMAIL, next: '/metrics' }),
    });
    expect(right.status).toBe(303);
    expect(right.headers.get('location')).toBe('/metrics');
    const setCookie = right.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`fue_access=${accessToken(CODE)}`);
    expect(setCookie).toContain('fue_evaluator=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain(CODE);

    expect((await app.request('/', { headers: { ...html, ...cookie } })).status).toBe(200);
    const api = await app.request('/api/inbox/stats', {
      headers: { ...cookie, authorization: `Bearer ${KEY}` },
    });
    expect(api.status).toBe(200);
    // The cookie opens the site, never the API: the clinic key is still required.
    expect((await app.request('/api/inbox/stats', { headers: cookie })).status).toBe(401);
    // A cookie for another code does not open it.
    const other = { cookie: `fue_access=${accessToken('another-code-of-16-chars')}` };
    expect((await app.request('/', { headers: { ...html, ...other } })).status).toBe(302);
  });

  it('limits wrong codes per client', async () => {
    const app = await site({ DEMO_ACCESS_CODE: CODE });
    const attempt = (forwardedFor: string, code = 'wrong-code-wrong-code') =>
      app.request('/_access', {
        method: 'POST',
        headers: { 'x-forwarded-for': forwardedFor },
        body: new URLSearchParams({ code, email: EMAIL }),
      });
    for (let index = 0; index < ACCESS_ATTEMPTS_PER_MINUTE; index += 1) {
      expect((await attempt('203.0.113.7')).status).toBe(401);
    }
    const limited = await attempt('203.0.113.7');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    // Another client is not affected, and the right code still works for everyone.
    expect((await attempt('198.51.100.2')).status).toBe(401);
    expect((await attempt('203.0.113.7', CODE)).status).toBe(303);
  });

  it('returns only to same-site paths', () => {
    expect(safeNextPath('/inbox/case-1?x=1')).toBe('/inbox/case-1?x=1');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('/_access?next=/')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  it('rejects the right code with an invalid email, and keeps what was typed', async () => {
    const app = await site({ DEMO_ACCESS_CODE: CODE });
    const response = await app.request('/_access', {
      method: 'POST',
      body: new URLSearchParams({ code: CODE, email: 'not-an-email', next: '/metrics' }),
    });
    expect(response.status).toBe(422);
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = await response.text();
    expect(body).toContain('valid email');
    expect(body).toContain('value="not-an-email"');
  });

  it('pre-fills the code page with the evaluator cookie\'s email ("Change")', async () => {
    const app = await site({ DEMO_ACCESS_CODE: CODE });
    const page = await app.request('/_access', { headers: cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`value="${EMAIL}"`);
  });
});

describe('evaluator identity', () => {
  it('reports who is evaluating and clears both cookies on logout', async () => {
    const app = await site({ INBOX_DIST_DIR: dist, DEMO_ACCESS_CODE: CODE });
    const me = await app.request('/api/evaluator/me', {
      headers: { ...cookie, authorization: `Bearer ${KEY}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ email: EMAIL });

    const logout = await app.request('/api/evaluator/logout', {
      method: 'POST',
      headers: { ...cookie, authorization: `Bearer ${KEY}` },
    });
    expect(logout.status).toBe(204);
    // Hono's `deleteCookie` sets each cookie to empty with `Max-Age=0`: the
    // browser drops both, so the next page load goes back to the code page.
    const cleared = (logout.headers.get('set-cookie') ?? '').toLowerCase();
    expect(cleared).toContain('fue_access=;');
    expect(cleared).toContain('fue_evaluator=;');
    expect(cleared).toContain('max-age=0');
  });
});
