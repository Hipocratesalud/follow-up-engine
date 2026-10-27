import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmProviderError, LlmSchemaError } from '../errors.ts';
import type { ProviderCompletion, ProviderRequest } from '../usage.ts';
import type { StructuredLlmProvider } from './chat-completions.ts';
import {
  createSnapshotProvider,
  emptySnapshot,
  mergeSnapshots,
  parseSnapshot,
  snapshotKey,
  type LlmSnapshot,
} from './snapshot.ts';

const Output = z.object({ answer: z.string() });
const request = (note: string, model = 'muse-spark-1.3'): ProviderRequest<{ answer: string }> => ({
  model,
  messages: [
    { role: 'system', content: 'You extract.' },
    { role: 'user', content: note },
  ],
  output: { name: 'test_output', schema: Output },
});

function liveProvider(replies: string[]): StructuredLlmProvider & { calls: number } {
  const queue = [...replies];
  const provider = {
    name: 'meta',
    calls: 0,
    complete<TOutput>(req: ProviderRequest<TOutput>): Promise<ProviderCompletion<TOutput>> {
      provider.calls += 1;
      const raw = queue.shift() ?? '{}';
      return Promise.resolve({
        output: req.output.schema.parse(JSON.parse(raw)),
        usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 800 },
        latencyMs: 4200,
        provider: 'meta',
        model: req.model,
        rawOutput: raw,
      });
    },
  };
  return provider;
}

describe('snapshotKey', () => {
  it('changes with the model, the output, the messages and the tools', () => {
    const base = snapshotKey(request('note A'));
    expect(snapshotKey(request('note A'))).toBe(base);
    expect(snapshotKey(request('note B'))).not.toBe(base);
    expect(snapshotKey(request('note A', 'muse-spark-1.2'))).not.toBe(base);
    expect(
      snapshotKey({ ...request('note A'), output: { name: 'other', schema: Output } }),
    ).not.toBe(base);
    expect(
      snapshotKey({
        ...request('note A'),
        tools: [{ name: 'read_note', description: 'Reads a note', parameters: z.object({}) }],
      }),
    ).not.toBe(base);
  });

  it("ignores the reviewer's per-run patient reference, nothing else", () => {
    const review = (ref: string, age: number) =>
      snapshotKey(
        request(
          `<review_input>{"patientRef":"${ref}","asOf":"2026-01-05","ageYears":${String(age)}}</review_input>`,
        ),
      );
    expect(review('P-1a2b3c4d', 60)).toBe(review('P-9f8e7d6c', 60));
    expect(review('P-1a2b3c4d', 60)).not.toBe(review('P-1a2b3c4d', 61));
  });
});

describe('createSnapshotProvider', () => {
  it('records a live reply on a miss and replays it on the next identical request', async () => {
    const live = liveProvider(['{"answer":"metformin"}']);
    const recorded: string[] = [];
    const provider = createSnapshotProvider({
      snapshot: emptySnapshot('meta'),
      live,
      onRecord: (key) => recorded.push(key),
    });

    const first = await provider.complete(request('note A'));
    const second = await provider.complete(request('note A'));

    expect(live.calls).toBe(1);
    expect(recorded).toEqual([snapshotKey(request('note A'))]);
    expect(first.output).toEqual({ answer: 'metformin' });
    expect(second.output).toEqual({ answer: 'metformin' });
    expect(provider.name).toBe('meta');
    expect(provider.stats()).toEqual({ hits: 1, misses: 1 });
    const replayed: string[] = [];
    await createSnapshotProvider({
      snapshot: provider.snapshot(),
      onReplay: (key) => replayed.push(key),
    }).complete(request('note A'));
    expect(replayed).toEqual(recorded);
    expect(provider.snapshot().entries[snapshotKey(request('note A'))]).toMatchObject({
      model: 'muse-spark-1.3',
      rawOutput: '{"answer":"metformin"}',
    });
  });

  it('replays recorded usage and latency by default, and none when asked', async () => {
    const live = liveProvider(['{"answer":"x"}']);
    const recorder = createSnapshotProvider({ snapshot: emptySnapshot('meta'), live });
    await recorder.complete(request('note A'));
    const snapshot = recorder.snapshot();

    const recordedUsage = await createSnapshotProvider({ snapshot }).complete(request('note A'));
    expect(recordedUsage.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
    });
    expect(recordedUsage.latencyMs).toBe(4200);

    const free = await createSnapshotProvider({ snapshot, replayUsage: 'none' }).complete(
      request('note A'),
    );
    expect(free.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(free.latencyMs).toBe(0);
  });

  it('fails a miss without a live provider, non-retryable, with a log-safe message', async () => {
    const provider = createSnapshotProvider({ snapshot: emptySnapshot('meta') });
    const error = await provider
      .complete(request('Paciente Julio Rangel'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({ provider: 'meta', retryable: false, code: 'snapshot_miss' });
    expect((error as Error).message).not.toContain('Rangel');
  });

  it('validates a replayed reply against the schema of the request', async () => {
    const snapshot: LlmSnapshot = {
      ...emptySnapshot('meta'),
      entries: {
        [snapshotKey(request('note A'))]: {
          model: 'muse-spark-1.3',
          rawOutput: '{"wrong":1}',
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        },
      },
    };
    await expect(createSnapshotProvider({ snapshot }).complete(request('note A'))).rejects.toThrow(
      LlmSchemaError,
    );
  });

  it('does not record a failed live call', async () => {
    const failing: StructuredLlmProvider = {
      name: 'meta',
      complete: () =>
        Promise.reject(new LlmProviderError('meta', 'HTTP 503', { status: 503, retryable: true })),
    };
    const provider = createSnapshotProvider({ snapshot: emptySnapshot('meta'), live: failing });
    await expect(provider.complete(request('note A'))).rejects.toThrow('HTTP 503');
    expect(Object.keys(provider.snapshot().entries)).toHaveLength(0);
  });
});

describe('parseSnapshot / mergeSnapshots', () => {
  it('round-trips through JSON and rejects a malformed file', async () => {
    const live = liveProvider(['{"answer":"x"}']);
    const recorder = createSnapshotProvider({ snapshot: emptySnapshot('meta'), live });
    await recorder.complete(request('note A'));
    const text = JSON.stringify(recorder.snapshot());
    expect(parseSnapshot(text)).toEqual(recorder.snapshot());
    expect(() => parseSnapshot('{"format":2}')).toThrow(/snapshot/i);
  });

  it('merges entries, later ones winning, and keeps the provider', () => {
    const a: LlmSnapshot = {
      ...emptySnapshot('meta'),
      entries: {
        k1: {
          model: 'm',
          rawOutput: '1',
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        },
      },
    };
    const b: LlmSnapshot = {
      ...emptySnapshot('meta'),
      entries: {
        k2: {
          model: 'm',
          rawOutput: '2',
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        },
      },
    };
    const merged = mergeSnapshots(a, b);
    expect(Object.keys(merged.entries).sort()).toEqual(['k1', 'k2']);
    expect(merged.provider).toBe('meta');
    expect(() => mergeSnapshots(a, emptySnapshot('baseten'))).toThrow(/provider/);
  });
});

describe('invalid replies', () => {
  it('records a repairable invalid reply and replays it as the same schema error', async () => {
    const invalid: StructuredLlmProvider = {
      name: 'meta',
      complete: () =>
        Promise.reject(
          new LlmSchemaError('meta', {
            model: 'muse-spark-1.3',
            rawOutput: '{"wrong":1}',
            issues: 'answer: required',
            summary: '1 schema issue(s): answer: invalid_type',
            usage: { inputTokens: 900, outputTokens: 90 },
            repairable: true,
          }),
        ),
    };
    const recorder = createSnapshotProvider({ snapshot: emptySnapshot('meta'), live: invalid });
    await expect(recorder.complete(request('note A'))).rejects.toThrow(LlmSchemaError);

    const replay = createSnapshotProvider({ snapshot: recorder.snapshot() });
    const error = await replay.complete(request('note A')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmSchemaError);
    expect(error).toMatchObject({
      rawOutput: '{"wrong":1}',
      summary: '1 schema issue(s): answer: invalid_type',
      repairable: true,
      usage: { inputTokens: 900, outputTokens: 90 },
    });
  });
});

describe('allowLive', () => {
  it('fails a miss without calling the model while it returns false, and calls it after', async () => {
    const live = liveProvider(['{"answer":"x"}']);
    let open = false;
    const provider = createSnapshotProvider({
      snapshot: emptySnapshot('meta'),
      live,
      allowLive: () => open,
    });
    await expect(provider.complete(request('note A'))).rejects.toMatchObject({
      code: 'snapshot_miss',
      retryable: false,
    });
    expect(live.calls).toBe(0);
    open = true;
    await expect(provider.complete(request('note A'))).resolves.toMatchObject({
      output: { answer: 'x' },
    });
    expect(live.calls).toBe(1);
    expect(provider.stats()).toEqual({ hits: 0, misses: 2 });
  });
});
