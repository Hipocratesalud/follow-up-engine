import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { META_DEFAULT_MODEL, createMetaProvider } from './meta.ts';

/**
 * Opt-in smoke test against the real Meta Model API. Skipped unless both
 * `RUN_LLM_SMOKE=1` and `META_API_KEY` are set, so CI and `pnpm verify`
 * never spend money or need a key:
 *
 *   RUN_LLM_SMOKE=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
 *     --project @follow-up-engine/llm meta.smoke
 */
const apiKey = process.env['META_API_KEY'];
const enabled = process.env['RUN_LLM_SMOKE'] === '1' && apiKey !== undefined && apiKey !== '';

describe.skipIf(!enabled)('Meta Model API smoke test (real network)', () => {
  it('returns schema-valid structured output and token usage', async () => {
    const provider = createMetaProvider({ apiKey: apiKey ?? '' });
    const result = await provider.complete({
      model: META_DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Extract the ICD-10 category and the follow-up interval.' },
        { role: 'user', content: 'Pcte con DM2. Ctrl en 3 meses.' },
      ],
      output: {
        name: 'smoke',
        schema: z.object({ icd10: z.string(), months: z.number().nullable() }),
      },
      maxOutputTokens: 1_000,
      timeoutMs: 60_000,
    });
    expect(result.output.icd10.toUpperCase()).toContain('E11');
    expect(result.output.months).toBe(3);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 90_000);
});
