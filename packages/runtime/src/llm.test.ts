import {
  type ClinicDirectory,
  clinicId,
  SystemClock,
  UnmaskedImageRefusedError,
} from '@follow-up-engine/core';
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

  it('reads META_BASE_URL, unset by default (the provider falls back to META_API_BASE_URL)', () => {
    expect(loadRuntimeConfig({ META_API_KEY: 'key' }).llm.metaBaseUrl).toBeUndefined();
    expect(
      loadRuntimeConfig({ META_API_KEY: 'key', META_BASE_URL: 'https://relay.example/v1' }).llm
        .metaBaseUrl,
    ).toBe('https://relay.example/v1');
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

  it('replays a recorded reading under meta at no cost, and calls (and prices) the model on a miss', async () => {
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
    // Replayed, not a real call: accounted (so "notes read" still counts it)
    // but at zero cost, so it never feeds the monthly budget or the cost the
    // inbox shows (no real spend was made).
    const usage = await usageLog.summary(clinicId('c1'), new Date(0));
    expect(usage).toMatchObject({ calls: 1, successfulCalls: 1, costUsd: 0 });
    expect(usage.byModel).toMatchObject([
      { provider: 'meta', model: 'muse-spark-1.3', calls: 1, costUsd: 0 },
    ]);

    const other = await second.extractor.extract(clinicId('c1'), {
      ...NOTE,
      text: `${NOTE.text} Nota nueva.`,
    });
    expect(other.planItems).toHaveLength(1);
    expect(replayer.calls).toHaveLength(1);
    expect(second.replay?.stats()).toEqual({ hits: 1, misses: 1 });
    // A genuine miss calls the model live, and is priced as a real call:
    // 3000 in, 400 out at Muse Spark list price.
    const afterMiss = await usageLog.summary(clinicId('c1'), new Date(0));
    expect(afterMiss.costUsd).toBeCloseTo((3000 * 1.25 + 400 * 4.25) / 1_000_000, 6);
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

  it('calls META_BASE_URL instead of the default Meta Model API when set (relay for egress-blocked hosts)', async () => {
    const config = loadRuntimeConfig({
      META_API_KEY: 'key',
      META_BASE_URL: 'https://relay.example/v1',
    }).llm;
    const recorder = metaFetch();
    const configured = createConfiguredExtractor(config, {
      ...deps(recorder.fetch),
      snapshot: { snapshot: emptySnapshot('meta') },
    });
    await configured.extractor.extract(clinicId('c1'), NOTE);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatch(/^https:\/\/relay\.example\/v1\/chat\/completions/);
  });

  it("sends the agent's live voice notes and lab photos through META_BASE_URL too (the hosted demo's relay)", async () => {
    const config = loadRuntimeConfig({
      META_API_KEY: 'key',
      META_BASE_URL: 'https://relay.example/v1',
    }).llm;
    const calls: string[] = [];
    const fetch: FetchLike = (url) => {
      calls.push(url);
      const body = url.endsWith('/asr/transcribe')
        ? { sessionId: 's1', transcript: 'Ya me hice el examen.', audioDurationMs: 1200, turns: [] }
        : {
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    isLabReport: true,
                    reportDate: '2026-01-05',
                    patientName: null,
                    tests: [
                      {
                        name: 'HbA1c',
                        value: 8.4,
                        unit: '%',
                        referenceLow: 4,
                        referenceHigh: 5.6,
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 200 },
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    // A clinic that allows unmasked images (the demo, a lab sandbox): photos may leave.
    const configured = createConfiguredExtractor(config, {
      ...deps(fetch),
      clinics: {
        get: () => Promise.resolve({ settings: { allowUnmaskedImagesToProvider: true } }),
      } as unknown as ClinicDirectory,
    });
    const voice = await configured.mediaReader.transcribe(clinicId('c1'), {
      mode: 'live',
      audio: new Uint8Array([82, 73, 70, 70]),
      contentType: 'audio/wav',
    });
    const photo = await configured.mediaReader.readLabPhoto(clinicId('c1'), {
      mode: 'live',
      image: new Uint8Array([255, 216, 255]),
      contentType: 'image/jpeg',
    });
    expect(calls).toEqual([
      'https://relay.example/v1/asr/transcribe',
      'https://relay.example/v1/chat/completions',
    ]);
    expect(voice.transcript).toBe('Ya me hice el examen.');
    expect(voice.model).toBe('meta:muse-voice-transcribe-1.0');
    expect(photo.reading.tests.map((test) => test.name)).toEqual(['HbA1c']);

    // Any other clinic (here, an unknown one): the photo never reaches the relay.
    const strict = createConfiguredExtractor(config, deps(fetch));
    await expect(
      strict.mediaReader.readLabPhoto(clinicId('c2'), {
        mode: 'live',
        image: new Uint8Array([255, 216, 255]),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(UnmaskedImageRefusedError);
    expect(calls).toHaveLength(2);
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
