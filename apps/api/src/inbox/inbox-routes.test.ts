import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../http/app.ts';
import type { App } from '../http/context.ts';
import type { CaseDetail, CaseView, InboxStats } from '../http/schemas.ts';
import { seedSyntheticClinic } from '../test/seed.ts';

/*
 * The inbox JSON API against a seeded synthetic clinic (memory storage, fake
 * clock): what the clinic team sees, counted, filtered and worded the way
 * the inbox shows it.
 */

const KEY = 'inbox-routes-key';
const SEED_PATIENTS = 40;

interface CasePage {
  readonly items: CaseView[];
  readonly nextCursor?: string;
  readonly total: number;
}

interface Owner {
  readonly id: string;
  readonly name: string;
  readonly activeCases: number;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

interface Harness {
  readonly runtime: EngineRuntime;
  readonly app: App;
  // The response body is JSON the test asserts on: callers name its shape.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  call<T>(path: string, body?: unknown): Promise<{ status: number; body: T }>;
}

async function seededHarness(): Promise<Harness> {
  const runtime = await createRuntime(loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent' }));
  await seedSyntheticClinic(runtime, { apiKey: KEY, patients: SEED_PATIENTS });
  const app = createApp(runtime, { corsOrigins: [] });
  return {
    runtime,
    app,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    async call<T>(path: string, body?: unknown) {
      const response = await app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${KEY}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
    },
  };
}

async function allPages(h: Harness, path: string): Promise<CasePage[]> {
  const pages: CasePage[] = [];
  let cursor: string | undefined;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const page = await h.call<CasePage>(
      cursor === undefined ? path : `${path}${separator}cursor=${encodeURIComponent(cursor)}`,
    );
    expect(page.status).toBe(200);
    pages.push(page.body);
    cursor = page.body.nextCursor;
  } while (cursor !== undefined);
  return pages;
}

async function advance(h: Harness, days: number): Promise<void> {
  expect((await h.call('/api/demo/clock/advance', { days })).status).toBe(200);
}

/** English status values and identifiers the clinic team must never read. */
const INTERNAL_TOKENS =
  /\b(open|notified|snoozed|escalated|resolved|dismissed|lost_to_follow_up|status|reason)\b/;

describe('inbox API on a seeded clinic', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await seededHarness();
  });
  afterEach(async () => {
    await h.runtime.close();
  });

  describe('HIP-114 counts', () => {
    it('returns the total of the view with every page, and pages reach every case', async () => {
      const stats = await h.call<InboxStats>('/api/inbox/stats');
      const pages = await allPages(h, '/api/inbox/cases?view=active&limit=10');
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        expect(page.total).toBe(stats.body.activeCases);
      }
      const ids = pages.flatMap((page) => page.items.map((item) => item.id));
      expect(new Set(ids).size).toBe(stats.body.activeCases);
    });
  });

  describe('HIP-125 owner filter', () => {
    it('lists the owners with display names, and filters by owner id', async () => {
      const owners = await h.call<{ items: Owner[] }>('/api/inbox/owners');
      expect(owners.status).toBe(200);
      const practitioner = owners.body.items.find((owner) => owner.id.startsWith('prac-'));
      expect(practitioner).toBeDefined();
      expect(practitioner?.name).toMatch(/^(Dr|Dra|Psic)\./);
      for (const owner of owners.body.items) {
        const page = await h.call<CasePage>(
          `/api/inbox/cases?view=active&limit=200&assignee=${encodeURIComponent(owner.id)}`,
        );
        expect(page.body.total).toBe(owner.activeCases);
        expect(page.body.items.length).toBe(owner.activeCases);
        expect(page.body.items.every((item) => item.assignee === owner.name)).toBe(true);
        expect(page.body.items.every((item) => item.assigneeId === owner.id)).toBe(true);
      }
      const active = await h.call<InboxStats>('/api/inbox/stats');
      expect(owners.body.items.reduce((sum, owner) => sum + owner.activeCases, 0)).toBe(
        active.body.activeCases,
      );
    });
  });

  describe('HIP-125 escalation meter', () => {
    it("follows the case's escalation policy: one labelled step per policy step and the next action", async () => {
      await advance(h, 15);
      const page = await h.call<CasePage>('/api/inbox/cases?view=active&origin=backfill&limit=5');
      const item = page.body.items[0];
      expect(item).toBeDefined();
      const escalation = item?.escalation;
      // The demo clinic runs default_v2: WhatsApp, call, coordinator, WhatsApp, lost.
      expect(escalation?.policyId).toBe('default_v2');
      expect(escalation?.steps.map((step) => step.action)).toEqual([
        'notify_clinic',
        'raise_priority',
        'request_patient_contact',
        'request_patient_contact',
        'escalate_to_coordinator',
        'request_patient_contact',
        'mark_lost_to_follow_up',
      ]);
      expect(escalation?.steps.every((step) => step.label.length > 0)).toBe(true);
      expect(JSON.stringify(escalation)).not.toMatch(/Médico tratante/);
      expect(escalation?.currentStep).toBe(item?.escalationStep);
      expect(escalation?.next?.action).toBe(
        escalation?.steps[escalation.currentStep]?.action ?? 'none',
      );
      expect(escalation?.next?.at).toBe(item?.nextActionAt);

      const detail = await h.call<CaseDetail>(`/api/inbox/cases/${item?.id ?? ''}`);
      const steps = detail.body.escalation.steps;
      // Day 15 of a backfill case: notified, priority raised; patient contact is
      // never automatic for a backfill case, so it was skipped, not done.
      expect(steps[0]?.outcome).toBe('done');
      expect(steps[1]?.outcome).toBe('done');
      expect(steps[2]?.outcome).toBe('skipped');
      expect(steps[3]?.outcome).toBeUndefined();
      expect(steps[1]?.at).toBeDefined();
    });

    it('shows lost to follow-up as skipped when nobody contacted the patient: the case stays with the team', async () => {
      await advance(h, 90);
      const page = await h.call<CasePage>('/api/inbox/cases?view=active&origin=backfill&limit=5');
      const item = page.body.items.find(
        (candidate) => candidate.escalation.currentStep === candidate.escalation.steps.length,
      );
      expect(item).toBeDefined();
      expect(item?.escalation.next).toBeUndefined();
      const detail = await h.call<CaseDetail>(`/api/inbox/cases/${item?.id ?? ''}`);
      expect(detail.body.escalation.steps.map((step) => [step.action, step.outcome])).toEqual([
        ['notify_clinic', 'done'],
        ['raise_priority', 'done'],
        ['request_patient_contact', 'skipped'],
        ['request_patient_contact', 'skipped'],
        ['escalate_to_coordinator', 'done'],
        ['request_patient_contact', 'skipped'],
        ['mark_lost_to_follow_up', 'skipped'],
      ]);
      // Each skipped attempt says why in the timeline: a backfill case never contacts by itself.
      expect(
        detail.body.timeline.filter((entry) => entry.type === 'contact_attempt_skipped'),
      ).toHaveLength(3);
      expect(detail.body.contactAttempts).toEqual([]);
      expect(detail.body.timeline.some((entry) => entry.type === 'lost_to_follow_up')).toBe(false);
    });
  });

  describe('HIP-126 patient search', () => {
    it('finds the cases of a patient by name or by patient id', async () => {
      const first = (await h.call<CasePage>('/api/inbox/cases?view=active&limit=1')).body.items[0];
      const name = first?.patient.name ?? '';
      const surname = name.split(' ').at(-1) ?? '';
      const byName = await h.call<CasePage>(
        `/api/inbox/cases?view=active&q=${encodeURIComponent(surname.toLowerCase())}`,
      );
      expect(byName.body.items.map((item) => item.patient.id)).toContain(first?.patient.id);
      expect(byName.body.total).toBe(byName.body.items.length);
      expect(
        byName.body.items.every((item) =>
          item.patient.name.toLowerCase().includes(surname.toLowerCase()),
        ),
      ).toBe(true);
      // The whole name, in any case and without accents, finds it too.
      const plain = name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toUpperCase();
      const byFullName = await h.call<CasePage>(
        `/api/inbox/cases?view=active&q=${encodeURIComponent(plain)}`,
      );
      expect(byFullName.body.items.map((item) => item.patient.id)).toContain(first?.patient.id);
      const byPatient = await h.call<CasePage>(
        `/api/inbox/cases?view=all&patient=${encodeURIComponent(first?.patient.id ?? '')}`,
      );
      expect(byPatient.body.items.length).toBeGreaterThan(0);
      expect(byPatient.body.items.every((item) => item.patient.id === first?.patient.id)).toBe(
        true,
      );
    });

    it('lists every patient of the clinic for the demo selector', async () => {
      const patients = await h.call<{ items: { id: string }[] }>('/api/inbox/patients?limit=500');
      expect(patients.status).toBe(200);
      expect(patients.body.items.length).toBe(SEED_PATIENTS);
    });
  });

  describe('HIP-126 feedback rate', () => {
    it('counts one verdict per case: the latest', async () => {
      const caseId = (await h.call<CasePage>('/api/inbox/cases?limit=1')).body.items[0]?.id ?? '';
      await h.call(`/api/inbox/cases/${caseId}/feedback`, { useful: false, reason: 'other' });
      await h.call(`/api/inbox/cases/${caseId}/feedback`, { useful: true });
      const stats = await h.call<InboxStats>('/api/inbox/stats');
      expect(stats.body.feedback).toEqual({ total: 1, usefulRate: 1 });
    });
  });

  describe('HIP-126 internal notes', () => {
    it('keeps the note of every action and shows it in the timeline', async () => {
      const ids = (await h.call<CasePage>('/api/inbox/cases?limit=4')).body.items.map(
        (item) => item.id,
      );
      const [snoozeId = '', notifyId = '', resolveId = '', dismissId = ''] = ids;
      const notes: [string, Record<string, unknown>, string][] = [
        [snoozeId, { action: 'snooze', snoozeDays: 3 }, 'NOTA-POSPONER'],
        [notifyId, { action: 'notify' }, 'NOTA-CONTACTO'],
        [resolveId, { action: 'resolve' }, 'NOTA-RESOLVER'],
        [dismissId, { action: 'dismiss', reason: 'already_done' }, 'NOTA-DESCARTE'],
      ];
      for (const [caseId, action, note] of notes) {
        const response = await h.call<CaseDetail | ErrorBody>(
          `/api/inbox/cases/${caseId}/actions`,
          { ...action, note },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const detail = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`);
        expect(detail.body.timeline.map((entry) => entry.note)).toContain(note);
      }
    });
  });

  describe('HIP-127 Spanish copy', () => {
    it('answers an invalid transition in Spanish, without English states', async () => {
      const caseId = (await h.call<CasePage>('/api/inbox/cases?limit=1')).body.items[0]?.id ?? '';
      expect(
        (await h.call(`/api/inbox/cases/${caseId}/actions`, { action: 'resolve' })).status,
      ).toBe(200);
      for (const action of ['dismiss', 'resolve', 'notify'] as const) {
        const response = await h.call<ErrorBody>(`/api/inbox/cases/${caseId}/actions`, {
          action,
          ...(action === 'dismiss' ? { reason: 'already_done' } : {}),
        });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('invalid_transition');
        expect(response.body.error.message).not.toMatch(INTERNAL_TOKENS);
        expect(response.body.error.message).toMatch(/resuelto/);
      }
    });

    it('asks for a feedback reason in Spanish', async () => {
      const caseId = (await h.call<CasePage>('/api/inbox/cases?limit=1')).body.items[0]?.id ?? '';
      const response = await h.call<ErrorBody>(`/api/inbox/cases/${caseId}/feedback`, {
        useful: false,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.message).not.toMatch(INTERNAL_TOKENS);
      expect(response.body.error.message).toMatch(/motivo/);
    });

    it('names reasons in the timeline as on the reason cards, never by rule id', async () => {
      const page = await h.call<CasePage>('/api/inbox/cases?view=active&limit=200');
      const withPlan = page.body.items.find(
        (item) => item.reasons.length > 1 && item.reasons.some((r) => r.layer === 'doctor_plan'),
      );
      expect(withPlan).toBeDefined();
      const detail = await h.call<CaseDetail>(`/api/inbox/cases/${withPlan?.id ?? ''}`);
      const cardLabels = detail.body.reasons.map((reason) => reason.label);
      const reasonEntries = detail.body.timeline.filter(
        (entry) => entry.type === 'opened' || entry.type === 'reason_added',
      );
      expect(reasonEntries.length).toBe(cardLabels.length);
      for (const entry of reasonEntries) {
        expect(cardLabels.some((label) => entry.label.endsWith(label))).toBe(true);
      }
      for (const entry of detail.body.timeline) {
        expect(entry.label).not.toMatch(/[a-z]+_[a-z_]+/);
        expect(entry.label).not.toMatch(/por recuperar/i);
      }
    });
  });
});
