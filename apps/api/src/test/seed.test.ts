import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../http/app.ts';
import type { App } from '../http/context.ts';
import type { InboxStats } from '../http/schemas.ts';
import { seedSyntheticClinic, type SeedReport } from './seed.ts';

const KEY = 'seed-test-key';

describe('demo seed through the initial backfill', () => {
  let runtime: EngineRuntime;
  let app: App;
  let report: SeedReport;

  beforeAll(async () => {
    runtime = await createRuntime(loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent' }));
    report = await seedSyntheticClinic(runtime, { apiKey: KEY });
    app = createApp(runtime, { corsOrigins: [] });
  }, 120_000);

  afterAll(async () => {
    await runtime.close();
  });

  async function get<T>(path: string): Promise<T> {
    const response = await app.request(path, { headers: { authorization: `Bearer ${KEY}` } });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  it('replays every patient and opens backfill cases, day 0 released, the rest held', () => {
    expect(report).toMatchObject({ seeded: true, patients: 120, bundles: 1680 });
    expect(report.documentsProcessed).toBeGreaterThan(600);
    expect(report.expectationsFulfilled).toBeGreaterThan(report.expectationsCreated / 2);
    expect(report.casesOpened).toBeGreaterThan(60);
    expect(report.casesOpened).toBeLessThan(150);
    expect(report.casesReleased + report.casesHeld).toBe(report.casesOpened);
    expect(report.casesReleased).toBeGreaterThan(0);
    expect(runtime.clock.now().toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });

  it('shows the released cases in the inbox, the held ones to recover, all from the backfill', async () => {
    const inbox = await get<{ items: { origin: string }[] }>('/api/inbox/cases?limit=200');
    expect(inbox.items).toHaveLength(report.casesReleased);
    expect(inbox.items.every((item) => item.origin === 'backfill')).toBe(true);
    const recovery = await get<{ total: number }>('/api/inbox/recovery');
    expect(recovery.total).toBe(report.casesHeld);
    const stats = await get<InboxStats>('/api/inbox/stats');
    expect(stats.activeCases).toBe(report.casesReleased);
    expect(stats.llm).toMatchObject({ provider: 'fake', calls: report.documentsProcessed });
  });

  it('is a no-op on an already seeded clinic', async () => {
    const again = await seedSyntheticClinic(runtime, { apiKey: KEY });
    expect(again).toMatchObject({
      seeded: false,
      eventsStaged: 0,
      casesOpened: report.casesOpened,
      casesReleased: report.casesReleased,
    });
  });
});
