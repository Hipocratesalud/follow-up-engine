import type { SimulationReport } from '@follow-up-engine/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test/harness.ts';

/** `GET /api/inbox/value/simulation`: the shipped snapshot at once, another size in the background. */

describe('the value simulation endpoint', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers the default size at once from the snapshot, with both arms and intervals', async () => {
    const response = await h.call<SimulationReport>('/api/inbox/value/simulation');
    expect(response.status).toBe(200);
    const report = response.body;
    expect(report.seeds).toHaveLength(20);
    expect(report.cohort.patientsPerArm).toBe(400);
    expect(report.notice).toContain('not a clinical trial');
    for (const arm of [report.arms.control, report.arms.agent]) {
      expect(arm.fulfilledShare.low).toBeLessThanOrEqual(arm.fulfilledShare.mean);
      expect(arm.fulfilledShare.high).toBeGreaterThanOrEqual(arm.fulfilledShare.mean);
    }
    expect(report.personas).toHaveLength(8);
    expect(report.invariants.controlAgentActions).toBe(0);
  });

  it('computes another size once in the background, then serves it', async () => {
    const path = '/api/inbox/value/simulation?patientsPerArm=50&seeds=1';
    const first = await h.call<{ status: string }>(path);
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('running');
    let response = first;
    for (let attempt = 0; attempt < 100 && response.status === 202; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      response = await h.call<{ status: string }>(path);
    }
    expect(response.status).toBe(200);
    expect((response.body as unknown as SimulationReport).cohort.patientsPerArm).toBe(50);
  });

  it('refuses a size outside the limits, and a caller without a key', async () => {
    expect((await h.call('/api/inbox/value/simulation?patientsPerArm=5000')).status).toBe(422);
    expect((await h.call('/api/inbox/value/simulation', { key: '' })).status).toBe(401);
  });
});
