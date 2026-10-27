import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caseToTask, expectationToTask, mapBundleToBatches } from '../src/index.ts';
import { escalatedCase, expiredPlanExpectation } from './domain-fixtures.ts';
import { loadBundle } from './helpers.ts';

/** Keeps docs/fhir.md honest: every JSON example in it is what the code produces. */

const doc = readFileSync(new URL('../../../docs/fhir.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
  (match) => JSON.parse(match[1] ?? 'null') as unknown,
);
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('docs/fhir.md', () => {
  it('has the five examples', () => {
    expect(examples).toHaveLength(5);
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

  it('shows the case and expectation Tasks the outbound mapping produces', () => {
    expect(examples[3]).toEqual(asJson(caseToTask(escalatedCase)));
    expect(examples[4]).toEqual(asJson(expectationToTask(expiredPlanExpectation)));
  });
});
