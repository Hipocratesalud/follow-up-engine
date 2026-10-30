import { readFileSync } from 'node:fs';
import {
  type ClinicId,
  NOTE_EXTRACTION_JOB,
  NOTE_EXTRACTION_MAX_ATTEMPTS,
} from '@follow-up-engine/core';
import { pino } from 'pino';
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
  let rt0: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
    await rt0?.close();
    rt0 = undefined;
  });

  async function setUp(): Promise<{ runtime: EngineRuntime; clinicId: ClinicId; worker: Worker }> {
    runtime = await createRuntime(
      loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: 'demo-key' }),
    );
    return { runtime, clinicId: 'clinic-demo' as ClinicId, worker: new Worker(runtime) };
  }

  it('queues the nightly reconciliation and runs it when the fake clock crosses 03:00 (HIP-141)', async () => {
    const { runtime: rt, clinicId, worker } = await setUp();
    await rt.ingestion.accept(clinicId, bundle, 'sync');
    // 2026-01-05 12:00Z; the demo clinic is on America/Caracas (UTC-4).
    const [sweep] = await worker.runSweeps([clinicId]);
    expect(sweep?.reconciliationDueAt).toEqual(new Date('2026-01-06T07:00:00.000Z'));
    // Sweeping again queues nothing new for the same night.
    await worker.runSweeps([clinicId]);
    expect(await rt.engine.reconciliation.runs(clinicId)).toEqual([]);

    await worker.advanceFakeClock(1, [clinicId]);
    const [run] = await rt.engine.reconciliation.runs(clinicId);
    expect(run).toMatchObject({
      runId: 'reconciliation-2026-01-06T07:00:00.000Z',
      scope: 'recent',
      status: 'completed',
      patientsScanned: 1,
      repairs: 0,
    });
    expect(rt.sink?.list().map((delivery) => delivery.type)).toContain('reconciliation.completed');
    expect(rt.sink?.list().map((delivery) => delivery.type)).not.toContain(
      'reconciliation.repairs_found',
    );
    // The next night is queued and runs, but nothing new was stored: no run, no webhook.
    const sent = rt.sink?.list().length;
    await worker.advanceFakeClock(1, [clinicId]);
    expect((await rt.engine.reconciliation.runs(clinicId)).map((each) => each.runId)).toEqual([
      'reconciliation-2026-01-06T07:00:00.000Z',
    ]);
    expect(rt.sink?.list().length).toBe(sent);
  });

  it('runs an asynchronously accepted Bundle, then opens and announces a case', async () => {
    const { runtime: rt, clinicId, worker } = await setUp();
    const accepted = await rt.ingestion.accept(clinicId, bundle, 'async');
    expect(accepted.jobId).toBeDefined();
    expect(await rt.storage.stores.expectations.listByPatient(clinicId, PATIENT as never)).toEqual(
      [],
    );

    // The bundle, then the adjudication of its ambiguous plan item (the demo
    // clinic runs the adjudicator in shadow).
    expect(await worker.runJobs()).toEqual({ completed: 2, failed: 0 });
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

  it('keeps retrying a failed note extraction for most of a day (api-fhir #13)', async () => {
    // Nothing listens on port 9: every model call fails fast without leaving the machine.
    rt0 = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: 'demo-key',
        LLM_PROVIDER: 'openai-compatible',
        OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_COMPATIBLE_API_KEY: 'none',
        OPENAI_COMPATIBLE_MODEL: 'offline',
      }),
    );
    const clinicId = 'clinic-demo' as ClinicId;
    const accepted = await rt0.ingestion.accept(clinicId, bundle, 'sync');
    expect(accepted.reports?.flatMap((report) => report.notes).map((n) => n.status)).toContain(
      'failed',
    );
    const [job] = await rt0.storage.jobs.claim({
      workerId: 'test',
      types: [NOTE_EXTRACTION_JOB],
      limit: 1,
      leaseFor: { minutes: 1 },
      now: new Date('2100-01-01T00:00:00Z'),
    });
    expect(job?.maxAttempts).toBe(NOTE_EXTRACTION_MAX_ATTEMPTS);
    const retryWindowMs = Array.from({ length: NOTE_EXTRACTION_MAX_ATTEMPTS - 1 }, (_, i) =>
      jobRetryDelayMs(i + 1),
    ).reduce((total, delay) => total + delay, 0);
    // Main gave up after 5 attempts (~75 s): a provider outage lost the doctor's plan.
    expect(retryWindowMs).toBeGreaterThan(20 * 3_600_000);
  }, 30_000);

  it('raises an alert when a note extraction gives up instead of dropping it silently', async () => {
    const lines: string[] = [];
    rt0 = await createRuntime(
      loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'info', DEMO_API_KEY: 'demo-key' }),
      { logger: pino({ level: 'info' }, { write: (line: string) => lines.push(line) }) },
    );
    const clinicId = 'clinic-demo' as ClinicId;
    await rt0.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.jobs.enqueue(clinicId, {
        type: NOTE_EXTRACTION_JOB,
        payload: { patientId: 'pat-x', documentId: 'doc-x' },
        maxAttempts: 1,
      }),
    );
    expect(await new Worker(rt0).runJobs()).toEqual({ completed: 0, failed: 1 });
    const alerts = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['alert'] === 'note_extraction_exhausted');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: 50, documentId: 'doc-x', patientId: 'pat-x' });
  });

  it('starts and stops its loops gracefully', async () => {
    const { worker } = await setUp();
    worker.start();
    expect(worker.running).toBe(true);
    await worker.stop();
    expect(worker.running).toBe(false);
  });
});
