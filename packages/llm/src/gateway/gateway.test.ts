import { FakeClock, LlmBudgetExceededError, clinicId } from '@follow-up-engine/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  LlmConfigError,
  LlmProviderError,
  LlmSchemaError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../errors.ts';
import type { PricingTable } from '../pricing.ts';
import type { StructuredLlmProvider } from '../providers/chat-completions.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import type { ProviderCompletion, ProviderRequest } from '../usage.ts';
import { createLlmGateway, startOfUtcMonth, type LlmGatewayConfig } from './gateway.ts';
import { backoffDelayMs } from './retry.ts';

const CLINIC = clinicId('clinic-under-test');
const Output = z.object({ value: z.string() });
const request = {
  task: 'note_extraction',
  promptVersion: 'test@1',
  messages: [{ role: 'user' as const, content: 'read this note' }],
  output: { name: 'out', schema: Output },
};

const PRICING: PricingTable = {
  'primary:p-model': { inputPerMTok: 1, outputPerMTok: 2, source: 'test' },
  'backup:b-model': { inputPerMTok: 10, outputPerMTok: 20, source: 'test' },
};

type Step = ((req: ProviderRequest<unknown>) => Promise<ProviderCompletion<unknown>>) | Error;

/** A provider that plays a script of replies and records every request it receives. */
function scriptedProvider(name: string, steps: Step[]) {
  const requests: ProviderRequest<unknown>[] = [];
  const provider: StructuredLlmProvider = {
    name,
    complete<TOutput>(req: ProviderRequest<TOutput>): Promise<ProviderCompletion<TOutput>> {
      requests.push(req);
      const step = steps.shift();
      if (!step) return Promise.reject(new Error('script exhausted'));
      if (step instanceof Error) return Promise.reject(step);
      return step(req) as Promise<ProviderCompletion<TOutput>>;
    },
  };
  return { provider, requests };
}

const ok =
  (value: string, inputTokens = 1_000_000, outputTokens = 500_000): Step =>
  (req) =>
    Promise.resolve({
      output: { value },
      usage: { inputTokens, outputTokens },
      latencyMs: 1,
      provider: 'x',
      model: req.model,
    });

const http = (status: number, retryAfterMs?: number): LlmProviderError =>
  new LlmProviderError('primary', `HTTP ${String(status)}`, {
    status,
    retryable: status === 429 || status >= 500,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

const schemaError = (raw: string): LlmSchemaError =>
  new LlmSchemaError('primary', {
    model: 'p-model',
    rawOutput: raw,
    issues: '✖ Invalid input: expected string, received number\n  → at value',
    summary: '1 schema issue(s): value: invalid_type',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    repairable: true,
  });

function gateway(
  providers: Record<string, StructuredLlmProvider>,
  overrides: Partial<LlmGatewayConfig> = {},
) {
  const usageLog = new InMemoryLlmUsageLog();
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  let id = 0;
  const instance = createLlmGateway({
    providers,
    tasks: { note_extraction: { route: [{ provider: 'primary', model: 'p-model' }] } },
    usageLog,
    pricing: PRICING,
    clock: new FakeClock(new Date('2026-10-27T10:00:00Z')),
    sleep,
    random: () => 0.5,
    newCallId: () => `call-${String((id += 1))}`,
    ...overrides,
  });
  return { gateway: instance, usageLog, sleep };
}

describe('llm gateway', () => {
  it('routes the task to its provider, computes cost and logs the call', async () => {
    const { provider, requests } = scriptedProvider('primary', [ok('hi')]);
    const { gateway: g, usageLog } = gateway({ primary: provider });

    const result = await g.complete(CLINIC, { ...request, temperature: 0, maxOutputTokens: 100 });

    expect(result).toMatchObject({
      output: { value: 'hi' },
      provider: 'primary',
      model: 'p-model',
      callId: 'call-1',
      costUsd: 2, // 1M in at $1 + 0.5M out at $2
      attempts: 1,
      repaired: false,
      totalCostUsd: 2,
    });
    expect(requests[0]).toMatchObject({ model: 'p-model', temperature: 0, maxOutputTokens: 100 });
    expect(usageLog.records).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        clinicId: CLINIC,
        task: 'note_extraction',
        promptVersion: 'test@1',
        provider: 'primary',
        model: 'p-model',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        costUsd: 2,
        ok: true,
        at: new Date('2026-10-27T10:00:00Z'),
      }),
    ]);
  });

  it('never sends the clinic id to the provider', async () => {
    const { provider, requests } = scriptedProvider('primary', [ok('hi')]);
    const { gateway: g } = gateway({ primary: provider });
    await g.complete(CLINIC, request);
    const sent = JSON.stringify({
      ...requests[0],
      signal: undefined,
      output: requests[0]?.output.name,
    });
    expect(sent).not.toContain('clinic-under-test');
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual(
      ['messages', 'model', 'output', 'signal', 'timeoutMs'].sort(),
    );
  });

  describe('budget', () => {
    it('refuses before calling the provider when the monthly budget is spent', async () => {
      const { provider, requests } = scriptedProvider('primary', [ok('a'), ok('b')]);
      const { gateway: g, usageLog } = gateway(
        { primary: provider },
        { monthlyBudgetUsd: () => 3 },
      );
      await g.complete(CLINIC, request); // $2, under budget
      await g.complete(CLINIC, request); // $4 spent now
      await expect(g.complete(CLINIC, request)).rejects.toBeInstanceOf(LlmBudgetExceededError);
      expect(requests).toHaveLength(2);
      expect(usageLog.records).toHaveLength(2);
    });

    it('only counts spend since the start of the UTC month and per clinic', async () => {
      const usageLog = new InMemoryLlmUsageLog();
      const base = {
        clinicId: CLINIC,
        task: 't',
        promptVersion: 'v',
        provider: 'primary',
        model: 'p-model',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        ok: true,
      };
      await usageLog.record({
        ...base,
        callId: 'old',
        costUsd: 100,
        at: new Date('2026-09-30T23:59:59Z'),
      });
      await usageLog.record({
        ...base,
        callId: 'other',
        clinicId: clinicId('other-clinic'),
        costUsd: 100,
        at: new Date('2026-10-05T00:00:00Z'),
      });
      const { provider } = scriptedProvider('primary', [ok('a')]);
      const { gateway: g } = gateway(
        { primary: provider },
        { usageLog, monthlyBudgetUsd: () => 5 },
      );
      await expect(g.complete(CLINIC, request)).resolves.toMatchObject({ output: { value: 'a' } });
      expect(startOfUtcMonth(new Date('2026-10-27T10:00:00Z'))).toEqual(
        new Date('2026-10-01T00:00:00Z'),
      );
    });

    it('has no cap when the budget is undefined', async () => {
      const { provider } = scriptedProvider('primary', [ok('a')]);
      const { gateway: g } = gateway({ primary: provider }, { monthlyBudgetUsd: () => undefined });
      await expect(g.complete(CLINIC, request)).resolves.toBeDefined();
    });
  });

  describe('retries', () => {
    it('retries 429 and 5xx with exponential backoff and jitter, honoring Retry-After', async () => {
      const { provider, requests } = scriptedProvider('primary', [
        http(429, 3000),
        http(503),
        ok('third'),
      ]);
      const { gateway: g, sleep, usageLog } = gateway({ primary: provider });

      const result = await g.complete(CLINIC, request);

      expect(result.output.value).toBe('third');
      expect(result.attempts).toBe(3);
      expect(requests).toHaveLength(3);
      // retry 1 after Retry-After 3000 + jitter 250; retry 2 after 500 * 2 + 250.
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3250, 1250]);
      expect(usageLog.records.map((r) => r.ok)).toEqual([false, false, true]);
      expect(usageLog.records[0]?.error).toContain('429');
    });

    it('does not retry a non-retryable error', async () => {
      const { provider, requests } = scriptedProvider('primary', [http(401), ok('never')]);
      const { gateway: g, sleep } = gateway({ primary: provider });
      await expect(g.complete(CLINIC, request)).rejects.toMatchObject({ status: 401 });
      expect(requests).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('gives up after maxAttempts', async () => {
      const { provider, requests } = scriptedProvider('primary', [
        http(500),
        http(500),
        http(500),
        ok('x'),
      ]);
      const { gateway: g } = gateway({ primary: provider });
      await expect(g.complete(CLINIC, request)).rejects.toMatchObject({ status: 500 });
      expect(requests).toHaveLength(3);
    });

    it('caps delays at maxDelayMs', () => {
      const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 4000 };
      expect(backoffDelayMs(policy, 1, () => 0)).toBe(500);
      expect(backoffDelayMs(policy, 3, () => 0)).toBe(2000);
      expect(backoffDelayMs(policy, 5, () => 0.99)).toBe(4000);
      expect(backoffDelayMs(policy, 1, () => 0, 60_000)).toBe(4000);
    });
  });

  it('times out a hanging provider, aborts its signal and retries', async () => {
    let aborted: unknown;
    const hang: Step = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          aborted = req.signal?.reason;
          reject(new Error('aborted by signal'));
        });
      });
    const { provider } = scriptedProvider('primary', [hang, ok('fast')]);
    const { gateway: g, usageLog } = gateway({ primary: provider }, { defaultTimeoutMs: 10 });

    const result = await g.complete(CLINIC, request);

    expect(result.output.value).toBe('fast');
    expect(aborted).toBeInstanceOf(LlmTimeoutError);
    expect(usageLog.records[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out') as unknown,
    });
  });

  it('times out even a provider that ignores the abort signal', async () => {
    const ignore: Step = () => new Promise(() => undefined);
    const { provider } = scriptedProvider('primary', [ignore]);
    const { gateway: g } = gateway(
      { primary: provider },
      { defaultTimeoutMs: 5, retry: { maxAttempts: 1 } },
    );
    await expect(g.complete(CLINIC, request)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  describe('output repair', () => {
    it('re-asks once with the validation error and the previous reply', async () => {
      const { provider, requests } = scriptedProvider('primary', [
        schemaError('{"value":1}'),
        ok('fixed'),
      ]);
      const { gateway: g, usageLog } = gateway({ primary: provider });

      const result = await g.complete(CLINIC, request);

      expect(result).toMatchObject({ output: { value: 'fixed' }, repaired: true, attempts: 2 });
      const repairMessages = requests[1]?.messages ?? [];
      expect(repairMessages.slice(0, 1)).toEqual(request.messages);
      expect(repairMessages[1]).toEqual({ role: 'assistant', content: '{"value":1}' });
      expect(repairMessages[2]?.role).toBe('user');
      expect(repairMessages[2]?.content).toContain('expected string, received number');
      // The failed attempt is still billed: 1M input tokens at $1.
      expect(usageLog.records.map((r) => [r.ok, r.costUsd])).toEqual([
        [false, 1],
        [true, 2],
      ]);
      expect(result.totalCostUsd).toBe(3);
    });

    it('throws when the repaired reply is still invalid', async () => {
      const { provider, requests } = scriptedProvider('primary', [
        schemaError('{"value":1}'),
        schemaError('{"value":2}'),
        ok('never'),
      ]);
      const { gateway: g } = gateway({ primary: provider });
      await expect(g.complete(CLINIC, request)).rejects.toBeInstanceOf(LlmSchemaError);
      expect(requests).toHaveLength(2);
    });

    it('validates provider output itself, even if the provider did not', async () => {
      const sloppy: Step = (req) =>
        Promise.resolve({
          output: { value: 42 },
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
          provider: 'x',
          model: req.model,
        });
      const { provider, requests } = scriptedProvider('primary', [sloppy, ok('good')]);
      const { gateway: g } = gateway({ primary: provider });
      const result = await g.complete(CLINIC, request);
      expect(result.repaired).toBe(true);
      expect(requests[1]?.messages[1]).toEqual({ role: 'assistant', content: '{"value":42}' });
    });

    it('does not repair a non-repairable output error', async () => {
      const truncated = new LlmSchemaError('primary', {
        model: 'p-model',
        rawOutput: '{"va',
        issues: 'truncated',
        summary: 'truncated',
        usage: { inputTokens: 1, outputTokens: 1 },
        repairable: false,
      });
      const { provider, requests } = scriptedProvider('primary', [truncated, ok('x')]);
      const { gateway: g } = gateway({ primary: provider });
      await expect(g.complete(CLINIC, request)).rejects.toBe(truncated);
      expect(requests).toHaveLength(1);
    });
  });

  describe('fallback', () => {
    const tasks = {
      note_extraction: {
        route: [
          { provider: 'primary', model: 'p-model' },
          { provider: 'backup', model: 'b-model' },
        ] as const,
      },
    } satisfies LlmGatewayConfig['tasks'];

    it('falls back to the next provider when the primary keeps failing', async () => {
      const primary = scriptedProvider('primary', [http(500), http(500), http(500)]);
      const backup = scriptedProvider('backup', [ok('from backup', 1000, 1000)]);
      const { gateway: g, usageLog } = gateway(
        { primary: primary.provider, backup: backup.provider },
        { tasks },
      );

      const result = await g.complete(CLINIC, request);

      expect(result).toMatchObject({ provider: 'backup', model: 'b-model', attempts: 4 });
      expect(backup.requests[0]?.model).toBe('b-model');
      expect(usageLog.records.map((r) => `${r.provider}:${String(r.ok)}`)).toEqual([
        'primary:false',
        'primary:false',
        'primary:false',
        'backup:true',
      ]);
    });

    it('reports every failure when the whole route fails', async () => {
      const primary = scriptedProvider('primary', [http(401)]);
      const backup = scriptedProvider('backup', [http(400)]);
      const { gateway: g } = gateway(
        { primary: primary.provider, backup: backup.provider },
        { tasks },
      );
      const error = await g.complete(CLINIC, request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmUnavailableError);
      expect((error as LlmUnavailableError).attempts.map((a) => a.provider)).toEqual([
        'primary',
        'backup',
      ]);
    });
  });

  describe('configuration', () => {
    it('rejects a route to an unknown provider', () => {
      expect(() =>
        createLlmGateway({
          providers: {},
          tasks: { t: { route: [{ provider: 'nope', model: 'm' }] } },
          usageLog: new InMemoryLlmUsageLog(),
        }),
      ).toThrow(LlmConfigError);
    });

    it('rejects a routed model without a price, so budgets cannot be bypassed', () => {
      const { provider } = scriptedProvider('primary', []);
      expect(() =>
        createLlmGateway({
          providers: { primary: provider },
          tasks: { t: { route: [{ provider: 'primary', model: 'unpriced' }] } },
          usageLog: new InMemoryLlmUsageLog(),
          pricing: PRICING,
        }),
      ).toThrow(/No price for primary:unpriced/);
    });

    it('rejects an unknown task at call time', async () => {
      const { provider } = scriptedProvider('primary', []);
      const { gateway: g } = gateway({ primary: provider });
      await expect(g.complete(CLINIC, { ...request, task: 'other' })).rejects.toBeInstanceOf(
        LlmConfigError,
      );
    });
  });
});
