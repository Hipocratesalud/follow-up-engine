import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  assertTestsExist,
  generateSignoffPages,
  REPO_ROOT,
  SIGNOFF_PROTOCOL_IDS,
  signoffPagePath,
} from './generate.ts';
import { API_LOCALES } from '../i18n/index.ts';

/*
 * The committed pages (docs/protocols/signoff/*.md, *.es.md) must be byte
 * for byte what `pnpm protocols:signoff` writes today: if they differ, the
 * config or the catalog moved on without the page, which is exactly what
 * this test exists to catch (common-brief's "add a test that fails if the
 * committed pages differ from a fresh generation"). `generateSignoffPages`
 * returns pre-Prettier markdown (production code never imports the dev
 * tool); this test formats it the same way `writeSignoffPages` does by
 * shelling out to the repo's own `prettier --write`, so the comparison is
 * exact.
 */

async function formatMarkdown(absolutePath: string, content: string): Promise<string> {
  const config = await resolveConfig(absolutePath);
  return format(content, { ...config, filepath: absolutePath });
}

describe('protocol sign-off pages', () => {
  it('cites only tests that literally exist, by their exact title', () => {
    expect(() => {
      assertTestsExist();
    }).not.toThrow();
  });

  it('every page committed in docs/protocols/signoff matches a fresh generation', async () => {
    const pages = generateSignoffPages();
    for (const protocolId of SIGNOFF_PROTOCOL_IDS) {
      for (const locale of API_LOCALES) {
        const path = signoffPagePath(protocolId, locale);
        const raw = pages.get(path);
        expect(raw, path).toBeDefined();
        const fresh = await formatMarkdown(join(REPO_ROOT, path), raw ?? '');
        const committed = readFileSync(join(REPO_ROOT, path), 'utf8');
        expect(committed, `${path} is stale — run "pnpm protocols:signoff" and commit it`).toBe(
          fresh,
        );
      }
    }
  });

  it('generates a page for every protocol this package covers', () => {
    const pages = generateSignoffPages();
    expect(pages.size).toBe(SIGNOFF_PROTOCOL_IDS.length * API_LOCALES.length);
  });
});
