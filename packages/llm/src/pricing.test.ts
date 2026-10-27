import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isStrictCompatible, toJsonSchema } from './json-schema.ts';
import { DEFAULT_PRICING, costOf, priceFor } from './pricing.ts';

describe('pricing', () => {
  it('prices Muse Spark at the published standard rate', () => {
    const price = priceFor(DEFAULT_PRICING, 'meta', 'muse-spark-1.3');
    expect(price).toMatchObject({
      inputPerMTok: 1.25,
      outputPerMTok: 4.25,
      cachedInputPerMTok: 0.15,
    });
    // 2,000 prompt tokens (1,500 cached) + 500 output tokens.
    if (!price) throw new Error('missing price');
    const cost = costOf(price, { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 500 });
    expect(cost).toBeCloseTo((500 * 1.25 + 1500 * 0.15 + 500 * 4.25) / 1e6, 9);
  });

  it('prices Muse Spark Open on Baseten and falls back to a provider wildcard', () => {
    expect(priceFor(DEFAULT_PRICING, 'baseten', 'meta-models/muse-spark-open')).toBeDefined();
    expect(
      priceFor({ '*:m': { inputPerMTok: 1, outputPerMTok: 1, source: 't' } }, 'any', 'm'),
    ).toBeDefined();
    expect(priceFor(DEFAULT_PRICING, 'meta', 'unknown-model')).toBeUndefined();
  });

  it('never bills more cached tokens than prompt tokens', () => {
    const price = { inputPerMTok: 1, outputPerMTok: 0, cachedInputPerMTok: 0, source: 't' };
    expect(
      costOf(price, { inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 0 }),
    ).toBe(0);
  });
});

describe('json schema', () => {
  it('converts zod with the built-in converter and drops $schema', () => {
    const schema = toJsonSchema(z.object({ a: z.string() }));
    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('detects schemas that cannot use strict mode', () => {
    expect(isStrictCompatible(toJsonSchema(z.object({ a: z.string().nullable() })))).toBe(true);
    expect(isStrictCompatible(toJsonSchema(z.object({ a: z.string().optional() })))).toBe(false);
    expect(isStrictCompatible(toJsonSchema(z.string()))).toBe(false);
    expect(
      isStrictCompatible(toJsonSchema(z.object({ a: z.looseObject({ b: z.string() }) }))),
    ).toBe(false);
    expect(
      isStrictCompatible(toJsonSchema(z.object({ a: z.record(z.string(), z.string()) }))),
    ).toBe(false);
  });
});
