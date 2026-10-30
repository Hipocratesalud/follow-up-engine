import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEscalationPoliciesFromJson,
  loadProtocolsFromJson,
  type Protocol,
} from '@follow-up-engine/core';
import { API_LOCALES, type ApiLocale } from '../i18n/index.ts';
import { buildSignoffPageData } from './model.ts';
import { renderSignoffPage } from './render.ts';
import { SIGNOFF_TESTS } from './tests.ts';

/** The repo root, from this file's own location (apps/api/src/protocol-signoff/). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CONFIG_DIR = join(REPO_ROOT, 'config');
export const SIGNOFF_DOCS_DIR = join(REPO_ROOT, 'docs', 'protocols', 'signoff');

/** Protocols this generator covers (MVP sign-off). Extend `tests.ts` before adding one. */
export const SIGNOFF_PROTOCOL_IDS = ['diabetes', 'hypertension'] as const;

function readJsonFiles(directory: string): {
  readonly names: string[];
  readonly documents: unknown[];
} {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile());
  return {
    names,
    documents: names.map((path) => JSON.parse(readFileSync(path, 'utf8')) as unknown),
  };
}

/** Every protocol in `config/protocols`, validated the same way the engine loads them. */
export function loadAllProtocols(): readonly Protocol[] {
  const policyFiles = readJsonFiles(join(CONFIG_DIR, 'rules', 'escalation'));
  const escalationPolicies = loadEscalationPoliciesFromJson(policyFiles.documents, {
    documentNames: policyFiles.names,
  });
  const protocolFiles = readJsonFiles(join(CONFIG_DIR, 'protocols'));
  return loadProtocolsFromJson(protocolFiles.documents, {
    documentNames: protocolFiles.names,
    escalationPolicies,
  });
}

/** Path (from the repo root) of the published page for `protocolId` in `locale`. */
export function signoffPagePath(protocolId: string, locale: ApiLocale): string {
  const suffix = locale === 'en' ? '.md' : '.es.md';
  return join('docs', 'protocols', 'signoff', `${protocolId}${suffix}`);
}

/**
 * Asserts every test cited in `tests.ts` is literally present (by its
 * `describe` and `it` title) in the file it names. Throws with every
 * missing one, not just the first, so a drifted page is never silent.
 */
export function assertTestsExist(): void {
  const byFile = new Map<string, string>();
  const missing: string[] = [];
  for (const items of Object.values(SIGNOFF_TESTS)) {
    for (const refs of Object.values(items)) {
      for (const ref of [refs.fires, ...refs.exceptions.map((exception) => exception.test)]) {
        let content = byFile.get(ref.file);
        if (content === undefined) {
          content = readFileSync(join(REPO_ROOT, ref.file), 'utf8');
          byFile.set(ref.file, content);
        }
        if (!content.includes(`describe('${ref.describe}'`)) {
          missing.push(`${ref.file}: no describe('${ref.describe}' ...)`);
        }
        if (!content.includes(`it('${ref.it}'`)) {
          missing.push(`${ref.file}: no it('${ref.it}' ...)`);
        }
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`protocol-signoff: cited tests that do not exist:\n- ${missing.join('\n- ')}`);
  }
}

/**
 * Every sign-off page, path (from the repo root) to its raw markdown
 * (pre-Prettier). Pure: reads the protocol config, writes nothing.
 * `generate.test.ts` formats this the same way `writeSignoffPages` does
 * before comparing it to the committed page.
 */
export function generateSignoffPages(): ReadonlyMap<string, string> {
  const allProtocols = loadAllProtocols();
  const pages = new Map<string, string>();
  for (const protocolId of SIGNOFF_PROTOCOL_IDS) {
    const protocol = allProtocols.find((candidate) => candidate.id === protocolId);
    if (protocol === undefined) {
      throw new Error(`protocol-signoff: "${protocolId}" is not in config/protocols`);
    }
    const tests = SIGNOFF_TESTS[protocolId];
    if (tests === undefined) {
      throw new Error(`protocol-signoff: no test catalog for "${protocolId}" in tests.ts`);
    }
    for (const locale of API_LOCALES) {
      const data = buildSignoffPageData(locale, protocol, allProtocols, tests);
      pages.set(signoffPagePath(protocolId, locale), renderSignoffPage(locale, data));
    }
  }
  return pages;
}

/**
 * Writes every generated page to `docs/protocols/signoff/`, then runs the
 * repo's own `prettier --write` on them (the CLI, not the npm package: a
 * doc generator has no business depending on a dev tool). Checks the
 * appendix's tests exist first.
 */
export function writeSignoffPages(): readonly string[] {
  assertTestsExist();
  const pages = generateSignoffPages();
  const written: string[] = [];
  for (const [path, content] of pages) {
    writeFileSync(join(REPO_ROOT, path), content, 'utf8');
    written.push(path);
  }
  execFileSync('pnpm', ['exec', 'prettier', '--write', ...written], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  return written;
}
