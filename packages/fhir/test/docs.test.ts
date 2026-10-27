import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  caseToTask,
  communicationToFhir,
  contactRequestToFhir,
  expectationToTask,
  mapBundleToBatches,
  suppressionToFlag,
} from '../src/index.ts';
import {
  activeSuppression,
  escalatedCase,
  expiredPlanExpectation,
  openExpectation,
  whatsappAttempt,
  wrongNumber,
} from './domain-fixtures.ts';
import { loadBundle } from './helpers.ts';

/** Keeps docs/fhir.md honest: every JSON example in it is what the code produces. */

const doc = readFileSync(new URL('../../../docs/fhir.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
  (match) => JSON.parse(match[1] ?? 'null') as unknown,
);
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

interface Coded {
  readonly id: string;
  readonly reason?: { readonly code: string };
  readonly items?: readonly { readonly key: string; readonly reason?: { readonly code: string } }[];
}

/** Rule ids, protocol ids, protocol rule ids and reason codes of the bundled catalog (config/). */
function catalogCodes(): {
  readonly rules: Set<string>;
  readonly reasons: Set<string>;
  readonly protocols: Set<string>;
} {
  const config = new URL('../../../config/', import.meta.url);
  const read = (dir: string): unknown[] =>
    readdirSync(new URL(dir, config))
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const parsed = JSON.parse(
          readFileSync(new URL(`${dir}${file}`, config), 'utf8'),
        ) as unknown;
        return Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
      });
  const rules = read('rules/') as Coded[];
  const protocols = read('protocols/') as Coded[];
  return {
    rules: new Set([
      ...rules.map((rule) => rule.id),
      ...protocols.flatMap((protocol) =>
        (protocol.items ?? []).map((item) => `protocol_${protocol.id}_${item.key}`),
      ),
    ]),
    reasons: new Set(
      [...rules, ...protocols, ...protocols.flatMap((protocol) => protocol.items ?? [])].flatMap(
        (item) => (item.reason === undefined ? [] : [item.reason.code]),
      ),
    ),
    protocols: new Set(protocols.map((protocol) => protocol.id)),
  };
}

/** Every rule, reason and protocol code a JSON example names, with what it should be. */
function namedCodes(
  value: unknown,
  found: { kind: 'rule' | 'reason' | 'protocol'; code: string }[] = [],
) {
  if (Array.isArray(value)) {
    value.forEach((item) => namedCodes(item, found));
  } else if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    const system = typeof node['system'] === 'string' ? node['system'] : '';
    const code = typeof node['code'] === 'string' ? node['code'] : undefined;
    const text = typeof node['value'] === 'string' ? node['value'] : undefined;
    if (code !== undefined && system.endsWith('/CodeSystem/follow-up-expectation')) {
      found.push({ kind: 'rule', code });
    }
    if (code !== undefined && system.endsWith('/CodeSystem/follow-up-reason')) {
      found.push({ kind: 'reason', code });
    }
    if (text !== undefined && system.endsWith('/NamingSystem/follow-up-rule')) {
      found.push({ kind: 'rule', code: text });
    }
    if (text !== undefined && system.endsWith('/NamingSystem/follow-up-expectation-key')) {
      found.push({ kind: 'rule', code: text.split('#')[1] ?? text });
    }
    if (
      typeof node['url'] === 'string' &&
      node['url'].endsWith('/follow-up-protocol-id') &&
      typeof node['valueString'] === 'string'
    ) {
      found.push({ kind: 'protocol', code: node['valueString'] });
    }
    for (const [key, inner] of Object.entries(node)) {
      if ((key === 'ruleId' || key === 'reasonCode') && typeof inner === 'string') {
        found.push({ kind: key === 'ruleId' ? 'rule' : 'reason', code: inner });
      }
      namedCodes(inner, found);
    }
  }
  return found;
}

describe('docs/fhir.md', () => {
  it('has the nine examples', () => {
    expect(examples).toHaveLength(9);
  });

  it('shows OperationOutcome issues the mapping really emits', () => {
    const { issues } = mapBundleToBatches(loadBundle('invalid-consultation'), {
      clinicId: 'clinic-demo',
      receivedAt: new Date('2026-01-05T20:00:00Z'),
    });
    const shown = examples[0] as { issue: unknown[] };
    for (const issue of shown.issue) {
      expect(issues?.issue).toContainEqual(issue);
    }
  });

  it('shows the diabetology fixture and the batch it maps to', () => {
    const bundle = loadBundle('consultation-diabetology');
    expect(examples[1]).toEqual(bundle);
    const { batches, issues } = mapBundleToBatches(bundle, {
      clinicId: 'clinic-demo',
      receivedAt: new Date('2026-01-05T18:31:00Z'),
    });
    expect(issues).toBeUndefined();
    expect(examples[2]).toEqual(asJson(batches[0]));
  });

  it('names only rule, reason and protocol codes that exist in the catalog', () => {
    const catalog = catalogCodes();
    const integration = readFileSync(
      new URL('../../../docs/integration.md', import.meta.url),
      'utf8',
    );
    const integrationExamples = [...integration.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (match) => JSON.parse(match[1] ?? 'null') as unknown,
    );
    const named = namedCodes([...examples, ...integrationExamples]);
    expect(named.length).toBeGreaterThan(5);
    const sets = { rule: catalog.rules, reason: catalog.reasons, protocol: catalog.protocols };
    expect(named.filter(({ kind, code }) => !sets[kind].has(code))).toEqual([]);
    // Codes named in the CodeSystem table.
    for (const system of ['follow-up-expectation', 'follow-up-reason']) {
      const row = doc.split('\n').find((line) => line.includes(`CodeSystem/${system}\``)) ?? '';
      const cell = row.split('|')[2] ?? '';
      for (const [, code = ''] of cell.matchAll(/`([a-z0-9_.]+)`/g)) {
        expect({
          system,
          code,
          known: catalog.rules.has(code) || catalog.reasons.has(code),
        }).toEqual({
          system,
          code,
          known: true,
        });
      }
    }
  });

  it('shows the case and expectation Tasks the outbound mapping produces', () => {
    expect(examples[3]).toEqual(
      asJson(caseToTask(escalatedCase, { reasons: [expiredPlanExpectation, openExpectation] })),
    );
    expect(examples[4]).toEqual(asJson(expectationToTask(expiredPlanExpectation)));
  });

  it('shows the attributed Appointment fixture the engine reads an origin from', () => {
    const fixture = loadBundle('appointment-attributed') as { entry: { resource: unknown }[] };
    expect(examples[8]).toEqual(fixture.entry[0]?.resource);
  });

  it('shows the contact loop resources the outbound mapping produces', () => {
    expect(examples[5]).toEqual(asJson(contactRequestToFhir(whatsappAttempt)));
    expect(examples[6]).toEqual(asJson(communicationToFhir(wrongNumber)));
    expect(examples[7]).toEqual(asJson(suppressionToFlag(activeSuppression)));
  });
});
