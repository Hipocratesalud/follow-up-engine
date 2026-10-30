import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAdjudicator } from '../../adjudicator/agent.ts';
import { ADJUDICATION_PROMPT_VERSION, ADJUDICATION_TASK } from '../../adjudicator/prompt.ts';
import {
  FAKE_ADJUDICATOR_MODEL,
  scriptedAdjudicatorResponder,
} from '../../adjudicator/scripted.ts';
import { createLlmGateway } from '../../gateway/gateway.ts';
import { DEFAULT_PRICING } from '../../pricing.ts';
import { createFakeProvider } from '../../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../../usage-log.ts';
import { loadAdjudicatorGold, renderAdjudicatorReport, runAdjudicatorEval } from './run.ts';

const GOLD = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'),
  'packages/testkit/fixtures/adjudicator-gold/gold.json',
);

describe('adjudicator eval on the gold set (scripted adjudicator, the real gateway)', () => {
  it('decides the synthetic ambiguous items with verified quotes, no open/discard flip', async () => {
    const usageLog = new InMemoryLlmUsageLog();
    const gateway = createLlmGateway({
      providers: { fake: createFakeProvider({ respond: scriptedAdjudicatorResponder }) },
      tasks: {
        [ADJUDICATION_TASK]: { route: [{ provider: 'fake', model: FAKE_ADJUDICATOR_MODEL }] },
      },
      usageLog,
      pricing: DEFAULT_PRICING,
    });
    const items = await loadAdjudicatorGold(GOLD);
    expect(items).toHaveLength(20);
    expect(new Set(items.map((item) => item.expected))).toEqual(
      new Set(['open', 'discard', 'needs_human']),
    );
    const run = await runAdjudicatorEval({
      items,
      adjudicator: createAdjudicator({ gateway }),
      provider: 'fake',
      model: FAKE_ADJUDICATOR_MODEL,
      promptVersion: ADJUDICATION_PROMPT_VERSION,
    });
    expect(run.totals.errors).toBe(0);
    expect(run.totals.unverifiedQuotes).toBe(0);
    expect(run.totals.flips).toBe(0);
    expect(run.totals.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(run.totals.brier).toBeLessThan(0.1);
    expect(run.totals.costUsd).toBe(0);
    // Every call went through the gateway and was accounted for.
    expect(usageLog.records).toHaveLength(20);
    expect(renderAdjudicatorReport(run, '2026-10-30')).toContain('Accuracy');
  });
});
