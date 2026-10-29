import { createHmac } from 'node:crypto';
import { emptySnapshot, parseSnapshot, startOfUtcMonth } from '@follow-up-engine/llm';
import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { LLM_SNAPSHOTS, readLlmSnapshot } from '@follow-up-engine/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiConfig } from '../config.ts';
import { accessToken, deriveSessionSecret } from '../http/site.ts';
import type { InboxStats } from '../http/schemas.ts';
import { createApiServer } from '../server.ts';
import { seedSyntheticClinic } from './seed.ts';

/*
 * Regression for a 2026 merge that broke the hosted demo's boot: the seed
 * replays the demo clinic's recorded Muse Spark readings
 * (`packages/testkit/fixtures/llm-snapshots/demo-clinic.meta.json`) under
 * `LLM_PROVIDER=meta`, exactly like `pnpm demo` does, with the same tight
 * `DEMO_LLM_MONTHLY_BUDGET_USD` a hosted preview runs with. Before the fix,
 * the gateway priced each replay as if it had called the model, so the
 * budget was exhausted by the seed itself: the backfill paused
 * (`paused_budget`) before it ever scheduled a release, and the inbox
 * showed 0 active patients with every backfill case stuck in "Por
 * recuperar", although no real spend had happened. Also asserts the
 * invariant the fix must preserve: the inbox is the one shared clinic
 * (`clinic-demo`) for every evaluator the site access gate lets in, never
 * an evaluator's own (empty) lab clinic.
 */

const APP_KEY = 'demo-boot-budget-key';
const INBOX_KEY = 'demo-boot-budget-inbox-key';
const CODE = 'demo-boot-budget-access-code-1234';
const EVALUATOR = 'evaluator@example.com';
const TIGHT_BUDGET_USD = 3;

function evaluatorCookie(email: string): string {
  const secret = deriveSessionSecret(CODE);
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe('the hosted demo boot under a tight monthly LLM budget', () => {
  it('releases day 0 of the backfill instead of pausing on replayed (free) snapshot calls', async () => {
    const snapshotText = readLlmSnapshot(LLM_SNAPSHOTS.demoClinic);
    const snapshot =
      snapshotText === undefined ? emptySnapshot('meta') : parseSnapshot(snapshotText);
    let seeding = true;
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        // An explicit LLM_PROVIDER picks `meta` (the snapshot's own
        // provider) whatever CI sets, exactly as the hosted demo does: the
        // bug only reproduces on the replay path, never on the fake
        // provider's free calls.
        LLM_PROVIDER: 'meta',
        META_API_KEY: 'unused-in-this-test',
        DEMO_API_KEY: APP_KEY,
        DEMO_INBOX_API_KEY: INBOX_KEY,
        DEMO_LLM_MONTHLY_BUDGET_USD: String(TIGHT_BUDGET_USD),
      }),
      {
        service: 'api',
        // Never a live call: every miss is read by the fake provider, so
        // this test never touches the network, deterministically.
        llmSnapshot: { snapshot, allowLive: () => !seeding },
      },
    );

    const report = await seedSyntheticClinic(runtime, {
      apiKey: APP_KEY,
      inboxApiKey: INBOX_KEY,
      llmMonthlyBudgetUsd: TIGHT_BUDGET_USD,
    });
    seeding = false;

    expect(report.casesReleased + report.casesHeld).toBe(report.casesOpened);
    // The regression: casesReleased used to be 0, every case stuck held.
    expect(report.casesReleased).toBeGreaterThan(0);
    expect(report.casesHeld).toBeGreaterThan(0);

    // The backfill actually completed; it did not pause on the budget.
    const progress = await runtime.engine.backfill.status(report.clinicId);
    expect(progress?.status).not.toBe('paused_budget');

    // Replays cost nothing: the month's LLM spend stays at zero even
    // though hundreds of notes were "read" by replaying the snapshot.
    const usage = await runtime.storage.llmUsage.summary(
      report.clinicId,
      startOfUtcMonth(runtime.clock.now()),
    );
    expect(usage.calls).toBeGreaterThan(0);
    expect(usage.costUsd).toBe(0);
  }, 30_000);

  it("a gated evaluator's inbox is the shared demo clinic, not their own lab clinic", async () => {
    const snapshotText = readLlmSnapshot(LLM_SNAPSHOTS.demoClinic);
    const snapshot =
      snapshotText === undefined ? emptySnapshot('meta') : parseSnapshot(snapshotText);
    let seeding = true;
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        LLM_PROVIDER: 'meta',
        META_API_KEY: 'unused-in-this-test',
        DEMO_API_KEY: APP_KEY,
        DEMO_INBOX_API_KEY: INBOX_KEY,
        DEMO_LLM_MONTHLY_BUDGET_USD: String(TIGHT_BUDGET_USD),
      }),
      { service: 'api', llmSnapshot: { snapshot, allowLive: () => !seeding } },
    );
    const report = await seedSyntheticClinic(runtime, {
      apiKey: APP_KEY,
      inboxApiKey: INBOX_KEY,
      llmMonthlyBudgetUsd: TIGHT_BUDGET_USD,
    });
    seeding = false;
    expect(report.casesReleased).toBeGreaterThan(0);

    const { app } = createApiServer(runtime, loadApiConfig({ DEMO_ACCESS_CODE: CODE }));
    const login = await app.request('/_access', {
      method: 'POST',
      body: new URLSearchParams({ code: CODE, email: EVALUATOR }),
    });
    expect(login.status).toBe(303);

    const headers = {
      authorization: `Bearer ${INBOX_KEY}`,
      cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EVALUATOR)}`,
    };
    const me = await app.request('/api/evaluator/me', { headers });
    expect(await me.json()).toEqual({ email: EVALUATOR });

    const stats = await app.request('/api/inbox/stats', { headers });
    expect(stats.status).toBe(200);
    const body = (await stats.json()) as InboxStats;
    // The shared clinic's released cases, exactly as the seed left them:
    // never an evaluator's own lab clinic, which always starts empty.
    expect(body.activeCases).toBe(report.casesReleased);

    const cases = await app.request('/api/inbox/cases?limit=200', { headers });
    const items = (await cases.json()) as { items: readonly { origin: string }[] };
    expect(items.items).toHaveLength(report.casesReleased);
    expect(items.items.every((item) => item.origin === 'backfill')).toBe(true);
  }, 30_000);
});
