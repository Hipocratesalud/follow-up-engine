import { type ClinicDirectory, clinicId, SystemClock } from '@follow-up-engine/core';
import {
  emptySnapshot,
  type FetchLike,
  NOTE_EXTRACTION_PROMPT_VERSION,
} from '@follow-up-engine/llm';
import { MemoryDatabase, MemoryLlmUsageLog } from '@follow-up-engine/adapter-memory';
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { createConfiguredExtractor } from './llm.ts';
import { createRuntime, DEMO_CLINIC } from './runtime.ts';

describe('which model reads the notes by default', () => {
  it('is Muse Spark on the Meta Model API when META_API_KEY is set', () => {
    const config = loadRuntimeConfig({ META_API_KEY: 'key' });
    expect(config.llm.provider).toBe('meta');
    expect(config.llm.metaApiKey).toBe('key');
  });

  it('is the fake provider without a key, and always in CI', () => {
    expect(loadRuntimeConfig({}).llm.provider).toBe('fake');
    expect(loadRuntimeConfig({ LLM_PROVIDER: '' }).llm.provider).toBe('fake');
    expect(loadRuntimeConfig({ LLM_PROVIDER: ' ', META_API_KEY: 'key' }).llm.provider).toBe('meta');
    expect(loadRuntimeConfig({ META_API_KEY: '' }).llm.provider).toBe('fake');
    expect(loadRuntimeConfig({ META_API_KEY: 'key', CI: 'true' }).llm.provider).toBe('fake');
    expect(loadRuntimeConfig({ META_API_KEY: 'key', CI: '1' }).llm.provider).toBe('fake');
  });

  it('follows an explicit LLM_PROVIDER whatever the key or CI', () => {
    expect(loadRuntimeConfig({ META_API_KEY: 'key', LLM_PROVIDER: 'fake' }).llm.provider).toBe(
      'fake',
    );
    expect(
      loadRuntimeConfig({ META_API_KEY: 'key', LLM_PROVIDER: 'meta', CI: 'true' }).llm.provider,
    ).toBe('meta');
  });
});

const EXTRACTION = {
  hasPlan: true,
  discharge: null,
  pregnancy: null,
  conditions: [{ icd10: 'E11', display: 'Type 2 diabetes', confidence: 0.9, evidenceQuote: 'DM2' }],
  medications: [],
  planItems: [
    {
      kind: 'follow_up_visit',
      description: 'follow-up visit',
      timing: { amount: 3, unit: 'month', date: null },
      loincCode: null,
      evidenceQuote: 'Ctrl en 3 meses',
      confidence: 0.9,
    },
  ],
};

function metaFetch(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(EXTRACTION) },
            },
          ],
          usage: { prompt_tokens: 3000, completion_tokens: 400 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  return { fetch, calls };
}

const NOTE = {
  documentId: 'doc-1',
  text: 'Pcte con DM2. Plan: metformina. Ctrl en 3 meses.',
  authoredAt: new Date('2026-01-05T12:00:00Z'),
  specialty: 'diabetology',
};

describe('a recorded Muse Spark snapshot', () => {
  const deps = (fetch: FetchLike) => ({
    usageLog: new MemoryLlmUsageLog(new MemoryDatabase()),
    clinics: { get: () => Promise.resolve(undefined) } as unknown as ClinicDirectory,
    clock: new SystemClock(),
    llmFetch: fetch,
  });

  it('replays a recorded reading under meta, priced as recorded, and calls the model on a miss', async () => {
    const config = loadRuntimeConfig({ META_API_KEY: 'key' }).llm;
    const recorder = metaFetch();
    const recorded: string[] = [];
    const first = createConfiguredExtractor(config, {
      ...deps(recorder.fetch),
      snapshot: {
        snapshot: emptySnapshot('meta', [NOTE_EXTRACTION_PROMPT_VERSION]),
        onRecord: (key) => recorded.push(key),
      },
    });
    await first.extractor.extract(clinicId('c1'), NOTE);
    expect(recorder.calls).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(first.replay?.stats()).toEqual({ hits: 0, misses: 1 });
    const snapshot = first.replay?.snapshot();
    expect(snapshot === undefined ? 0 : Object.keys(snapshot.entries).length).toBe(1);

    const replayer = metaFetch();
    const usageLog = new MemoryLlmUsageLog(new MemoryDatabase());
    const second = createConfiguredExtractor(config, {
      ...deps(replayer.fetch),
      usageLog,
      snapshot: { snapshot: snapshot ?? emptySnapshot('meta') },
    });
    const extraction = await second.extractor.extract(clinicId('c1'), NOTE);
    expect(replayer.calls).toHaveLength(0);
    expect(second.replay?.stats()).toEqual({ hits: 1, misses: 0 });
    expect(second.info).toEqual({ provider: 'meta', model: 'muse-spark-1.3' });
    expect(extraction.model).toBe('muse-spark-1.3');
    expect(extraction.planItems.map((item) => item.evidenceQuote)).toEqual(['Ctrl en 3 meses']);
    // Accounted as the Muse Spark call it replays: 3000 in, 400 out.
    const usage = await usageLog.summary(clinicId('c1'), new Date(0));
    expect(usage).toMatchObject({ calls: 1, successfulCalls: 1 });
    expect(usage.byModel).toMatchObject([{ provider: 'meta', model: 'muse-spark-1.3', calls: 1 }]);
    // 3000 in, 400 out at Muse Spark list price.
    expect(usage.costUsd).toBeCloseTo((3000 * 1.25 + 400 * 4.25) / 1_000_000, 6);

    const other = await second.extractor.extract(clinicId('c1'), {
      ...NOTE,
      text: `${NOTE.text} Nota nueva.`,
    });
    expect(other.planItems).toHaveLength(1);
    expect(replayer.calls).toHaveLength(1);
    expect(second.replay?.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it('replay-only: a miss is read by the fake provider and labeled fake, never called live', async () => {
    const config = loadRuntimeConfig({ META_API_KEY: 'key' }).llm;
    const fetch = metaFetch();
    const usageLog = new MemoryLlmUsageLog(new MemoryDatabase());
    let live = false;
    const configured = createConfiguredExtractor(config, {
      ...deps(fetch.fetch),
      usageLog,
      snapshot: { snapshot: emptySnapshot('meta'), allowLive: () => live },
    });
    const seeded = await configured.extractor.extract(clinicId('c1'), NOTE);
    expect(fetch.calls).toHaveLength(0);
    expect(seeded.model).toBe('fake-extractor');
    expect(seeded.planItems.map((item) => item.kind)).toEqual(['follow_up_visit']);

    live = true;
    const consultation = await configured.extractor.extract(clinicId('c1'), {
      ...NOTE,
      text: `${NOTE.text} Nueva consulta.`,
    });
    expect(fetch.calls).toHaveLength(1);
    expect(consultation.model).toBe('muse-spark-1.3');
    const usage = await usageLog.summary(clinicId('c1'), new Date(0));
    expect(usage.byModel.map((row) => `${row.provider}:${row.model}`).sort()).toEqual([
      'fake:fake-extractor',
      'meta:muse-spark-1.3',
    ]);
  });

  it('is ignored with the fake provider', () => {
    const configured = createConfiguredExtractor(loadRuntimeConfig({}).llm, {
      ...deps(metaFetch().fetch),
      snapshot: { snapshot: emptySnapshot('meta') },
    });
    expect(configured.info.provider).toBe('fake');
    expect(configured.replay).toBeUndefined();
  });
});

describe("the demo clinic's monthly LLM budget", () => {
  it('is DEMO_LLM_MONTHLY_BUDGET_USD when set, the clinic default otherwise', async () => {
    const base = { CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: 'budget-test-key' } as const;
    const capped = await createRuntime(
      loadRuntimeConfig({ ...base, DEMO_LLM_MONTHLY_BUDGET_USD: '10' }),
    );
    const defaulted = await createRuntime(loadRuntimeConfig(base));
    try {
      const id = clinicId(DEMO_CLINIC.id);
      expect((await capped.storage.clinics.get(id))?.settings.llmMonthlyBudgetUsd).toBe(10);
      expect((await defaulted.storage.clinics.get(id))?.settings.llmMonthlyBudgetUsd).toBe(50);
    } finally {
      await capped.close();
      await defaulted.close();
    }
    expect(() => loadRuntimeConfig({ DEMO_LLM_MONTHLY_BUDGET_USD: '-1' })).toThrow(
      /DEMO_LLM_MONTHLY_BUDGET_USD/,
    );
  });
});
