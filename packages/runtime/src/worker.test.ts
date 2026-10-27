import { readFileSync } from 'node:fs';
import { type ClinicId, NOTE_EXTRACTION_JOB } from '@follow-up-engine/core';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidConfigError, loadRuntimeConfig } from './config.ts';
import { INGEST_BUNDLE_JOB } from './ingestion.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';
import { jobRetryDelayMs, Worker } from './worker.ts';

const bundle: unknown = JSON.parse(
  readFileSync(
    new URL('../../fhir/fixtures/bundles/consultation-diabetology.json', import.meta.url),
    'utf8',
  ),
);
const PATIENT = '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01';

describe('runtime configuration', () => {
  it('defaults to memory storage, the system clock and the fake LLM', () => {
    const config = loadRuntimeConfig({});
    expect(config.databaseUrl).toBeUndefined();
    expect(config.clock).toEqual({ kind: 'system' });
    expect(config.llm.provider).toBe('fake');
    expect(config.webhooks.url).toBeUndefined();
  });

  it('lists every problem of an invalid environment', () => {
    expect(() =>
      loadRuntimeConfig({ LLM_PROVIDER: 'meta', WEBHOOK_URL: 'https://h.example', CLOCK: 'moon' }),
    ).toThrow(InvalidConfigError);
    try {
      loadRuntimeConfig({ LLM_PROVIDER: 'meta', WEBHOOK_URL: 'https://h.example' });
    } catch (error) {
      expect(String(error)).toMatch(/META_API_KEY/);
      expect(String(error)).toMatch(/WEBHOOK_SECRET/);
    }
  });

  it('starts a fake clock at the configured instant', () => {
    expect(
      loadRuntimeConfig({ CLOCK: 'fake', FAKE_CLOCK_START: '2026-02-01T00:00:00Z' }).clock,
    ).toEqual({
      kind: 'fake',
      start: new Date('2026-02-01T00:00:00Z'),
    });
  });
});

describe('job retry backoff', () => {
  it('doubles from 5 seconds and caps at one hour', () => {
    expect([1, 2, 3, 20].map(jobRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 3_600_000]);
  });
});

describe('worker over the memory runtime', () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
  });

  async function setUp(): Promise<{ runtime: EngineRuntime; clinicId: ClinicId; worker: Worker }> {
    runtime = await createRuntime(
      loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: 'demo-key' }),
    );
    return { runtime, clinicId: 'clinic-demo' as ClinicId, worker: new Worker(runtime) };
  }

  it('runs an asynchronously accepted Bundle, then opens and announces a case', async () => {
    const { runtime: rt, clinicId, worker } = await setUp();
    const accepted = await rt.ingestion.accept(clinicId, bundle, 'async');
    expect(accepted.jobId).toBeDefined();
    expect(await rt.storage.stores.expectations.listByPatient(clinicId, PATIENT as never)).toEqual(
      [],
    );

    expect(await worker.runJobs()).toEqual({ completed: 1, failed: 0 });
    const expectations = await rt.storage.stores.expectations.listByPatient(
      clinicId,
      PATIENT as never,
    );
    expect(expectations.map((item) => item.ruleId)).toContain('lab_order_result_pending');

    rt.fakeClock?.advance({ days: 16 });
    const [sweep] = await worker.runSweeps();
    expect(sweep?.watcher.casesOpened).toHaveLength(1);
    expect((await worker.deliverOutbox()).delivered).toBeGreaterThan(0);
    expect(rt.sink?.list().map((delivery) => delivery.type)).toContain('case.opened');
    expect(rt.sink?.list().every((delivery) => delivery.signatureValid)).toBe(true);
  });

  it('retries a failing job with backoff instead of losing it', async () => {
    const { runtime: rt, clinicId, worker } = await setUp();
    await rt.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.jobs.enqueue(clinicId, { type: INGEST_BUNDLE_JOB, payload: { nope: true } }),
    );
    await rt.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.jobs.enqueue(clinicId, {
        type: NOTE_EXTRACTION_JOB,
        payload: { patientId: 'pat-x', documentId: 'doc-x' },
      }),
    );
    expect(await worker.runJobs()).toEqual({ completed: 0, failed: 2 });
    expect(await worker.runJobs()).toEqual({ completed: 0, failed: 0 });
    rt.fakeClock?.advance({ seconds: 6 });
    expect((await worker.runJobs()).failed).toBe(2);
  });

  it('starts and stops its loops gracefully', async () => {
    const { worker } = await setUp();
    worker.start();
    expect(worker.running).toBe(true);
    await worker.stop();
    expect(worker.running).toBe(false);
  });
});
