import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../http/app.ts';
import type { App } from '../http/context.ts';
import type { CaseDetail, CaseView } from '../http/schemas.ts';
import { seedSyntheticClinic } from '../test/seed.ts';
import { calendarDaysBetween } from './presenter.ts';

/*
 * QA round 2 (HIP-126, HIP-131) on the full seeded demo clinic: overdue
 * counts on calendar days, the escalation schedule of a snoozed case, and a
 * demo whose "Por recuperar" holds cases released day by day.
 */

const KEY = 'qa-round-2-key';
const DAY_MS = 86_400_000;
const CLINIC_ZONE = 'America/Caracas';

interface Page {
  readonly items: CaseView[];
  readonly total: number;
}

interface Harness {
  readonly runtime: EngineRuntime;
  readonly app: App;

  call<T>(path: string, body?: unknown): Promise<T>;
}

async function seededHarness(): Promise<Harness> {
  const runtime = await createRuntime(loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent' }));
  await seedSyntheticClinic(runtime, { apiKey: KEY });
  const app = createApp(runtime, { corsOrigins: [] });
  return {
    runtime,
    app,

    async call<T>(path: string, body?: unknown) {
      const response = await app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${KEY}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return (await response.json()) as T;
    },
  };
}

/** "2026-01-19" in the clinic's zone: an independent way to read the calendar day. */
function localDate(iso: string): number {
  return Date.parse(new Date(iso).toLocaleDateString('en-CA', { timeZone: CLINIC_ZONE }));
}

describe('QA round 2 on the seeded demo clinic', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await seededHarness();
  }, 120_000);

  afterEach(async () => {
    await h.runtime.close();
  });

  describe('HIP-126 overdue label', () => {
    it('counts calendar days in the clinic zone, so a deadline that was yesterday is 1 day late', async () => {
      await h.call('/api/demo/clock/advance', { days: 15 });
      const now = h.runtime.clock.now().toISOString();
      const page = await h.call<Page>('/api/inbox/cases?view=all&limit=200');
      const reasons = page.items.flatMap((item) => item.reasons);
      expect(reasons.length).toBeGreaterThan(20);
      for (const reason of reasons) {
        const expected = Math.max(0, (localDate(now) - localDate(reason.dueAt)) / DAY_MS);
        expect(reason.overdueDays, `${reason.label} due ${reason.dueAt}`).toBe(expected);
      }
      // The case of the report: elapsed time floors a day short when the deadline's hour is later.
      const shortByElapsed = reasons.filter(
        (reason) =>
          Math.floor((Date.parse(now) - Date.parse(reason.dueAt)) / DAY_MS) < reason.overdueDays,
      );
      expect(shortByElapsed.length).toBeGreaterThan(0);
    });

    it('counts across the zone boundary as the clinic does', () => {
      // 20 Jan 02:00Z is still 19 Jan in Caracas (UTC-4).
      expect(
        calendarDaysBetween(
          new Date('2026-01-19T16:13:00Z'),
          new Date('2026-01-20T02:00:00Z'),
          CLINIC_ZONE,
        ),
      ).toBe(0);
      expect(
        calendarDaysBetween(
          new Date('2026-01-19T16:13:00Z'),
          new Date('2026-01-20T12:00:00Z'),
          CLINIC_ZONE,
        ),
      ).toBe(1);
      expect(
        calendarDaysBetween(
          new Date('2026-01-19T16:13:00Z'),
          new Date('2026-01-20T12:00:00Z'),
          'Not/AZone',
        ),
      ).toBe(1);
    });
  });

  describe('HIP-126 escalation of a snoozed case', () => {
    it('shows each pending step on the date the engine will run it, counted from the snooze end', async () => {
      const page = await h.call<Page>('/api/inbox/cases?limit=200');
      const target = page.items.find(
        (item) => item.escalation.next !== undefined && item.status !== 'snoozed',
      );
      expect(target).toBeDefined();
      const id = target?.id ?? '';
      const snoozed = await h.call<CaseDetail>(`/api/inbox/cases/${id}/actions`, {
        action: 'snooze',
        snoozeDays: 30,
      });
      expect(snoozed.status).toBe('snoozed');
      const until = Date.parse(snoozed.snoozedUntil ?? '');
      const pending = snoozed.escalation.steps.slice(snoozed.escalation.currentStep);
      expect(pending.length).toBeGreaterThan(0);
      for (const step of pending) {
        expect(step.scheduledAt, step.label).toBeDefined();
        expect(Date.parse(step.scheduledAt ?? '')).toBeGreaterThanOrEqual(until);
      }
      const opened = Date.parse(snoozed.openedAt);
      const first = pending[0];
      // Not "N days after the case opened": the snooze restarted the wait.
      expect(Date.parse(first?.scheduledAt ?? '')).not.toBe(
        opened + (first?.afterDays ?? 0) * DAY_MS,
      );

      await h.call('/api/demo/clock/advance', { days: 30 });
      const woken = await h.call<CaseDetail>(`/api/inbox/cases/${id}`);
      expect(woken.status).not.toBe('snoozed');
      expect(woken.escalation.currentStep).toBe(snoozed.escalation.currentStep);
      expect(woken.escalation.next?.at).toBe(first?.scheduledAt);
      expect(woken.escalation.steps.map((step) => step.scheduledAt)).toEqual(
        snoozed.escalation.steps.map((step) => step.scheduledAt),
      );
    });

    it('gives closed cases no schedule', async () => {
      const page = await h.call<Page>('/api/inbox/cases?limit=1');
      const id = page.items[0]?.id ?? '';
      const resolved = await h.call<CaseDetail>(`/api/inbox/cases/${id}/actions`, {
        action: 'resolve',
      });
      expect(resolved.escalation.steps.every((step) => step.scheduledAt === undefined)).toBe(true);
    });
  });

  describe('HIP-131 demo patients to recover', () => {
    it('caps day 0 at 5 cases per owner and holds the rest, each with its release day', async () => {
      const inbox = await h.call<Page>('/api/inbox/cases?limit=200');
      const perOwner = new Map<string, number>();
      for (const item of inbox.items) {
        const owner = item.assigneeId ?? 'front_desk';
        perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
      }
      expect(Math.max(...perOwner.values())).toBeLessThanOrEqual(5);
      const recovery = await h.call<Page>('/api/inbox/recovery?limit=200');
      expect(recovery.total).toBeGreaterThan(10);
      const now = Date.parse(h.runtime.clock.now().toISOString());
      for (const item of recovery.items) {
        if (item.releaseAt !== undefined) {
          expect(Date.parse(item.releaseAt)).toBeGreaterThan(now);
          expect(new Date(item.releaseAt).getUTCFullYear()).toBeLessThan(9999);
        }
      }
      expect(recovery.items.filter((item) => item.releaseAt !== undefined).length).toBeGreaterThan(
        0,
      );
    });

    it('releases the next batch to the inbox one day later', async () => {
      const before = await h.call<Page>('/api/inbox/recovery?limit=200');
      const tomorrow = Date.parse(h.runtime.clock.now().toISOString()) + DAY_MS;
      const due = before.items.filter(
        (item) => item.releaseAt !== undefined && Date.parse(item.releaseAt) <= tomorrow,
      );
      expect(due.length).toBeGreaterThan(0);
      await h.call('/api/demo/clock/advance', { days: 1 });
      const after = await h.call<Page>('/api/inbox/recovery?limit=200');
      expect(after.total).toBe(before.total - due.length);
      const inbox = await h.call<Page>('/api/inbox/cases?limit=200');
      const ids = new Set(inbox.items.map((item) => item.id));
      expect(due.every((item) => ids.has(item.id))).toBe(true);
    });
  });
});
