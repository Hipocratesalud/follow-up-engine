import { createHmac } from 'node:crypto';
import { clinicId as toClinicId } from '@follow-up-engine/core';
import {
  createRuntime,
  type EngineRuntime,
  labClinicId,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { loadReviewerCohort } from '@follow-up-engine/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.ts';
import type { App } from './http/context.ts';
import type { PatientQueueItem } from './http/patient-queue-schemas.ts';
import type { FindingFlagView, FindingView, InboxFindingList } from './http/reviewer-schemas.ts';
import { accessToken, deriveSessionSecret } from './http/site.ts';
import { createApiServer } from './server.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/*
 * PRD V3 "Inbox cards per validated category": findings of a category the
 * clinical team switched live (with a sign-off) become cards of the doctor's
 * inbox; a shadow category never does, in the API itself. Rated findings
 * leave the queue; another clinic never sees them.
 */

const cohort = loadReviewerCohort();
/** rev-0001: a creatinine trend; rev-0003: a symptom repeated across notes and a drug–condition conflict. */
const PATIENTS = ['rev-0001', 'rev-0003'] as const;

async function sendPatient(h: Harness, id: string): Promise<void> {
  const patient = cohort.patients.find((item) => item.patientId === id);
  for (const entry of patient?.entries ?? []) {
    const response = await h.call('/fhir?sync=true', { body: entry.bundle, fhir: true });
    expect(response.status, id).toBe(200);
  }
}

function setFlag(
  h: Harness,
  body: { category: string; mode: 'live' | 'shadow'; validatedBy?: string },
  key?: string,
) {
  return h.call<FindingFlagView>('/api/inbox/finding-flags', {
    method: 'PUT',
    body: { enabled: true, ...body },
    ...(key === undefined ? {} : { key }),
  });
}

async function inbox(h: Harness, key?: string): Promise<InboxFindingList> {
  const response = await h.call<InboxFindingList>(
    '/api/inbox/live-findings',
    key === undefined ? {} : { key },
  );
  expect(response.status).toBe(200);
  return response.body;
}

describe.each(STORAGES)('live findings in the doctor inbox (%s)', (storage) => {
  let h: Harness;
  let shadowCategories: string[];

  beforeAll(async () => {
    h = await createHarness({ storage });
    for (const id of PATIENTS) await sendPatient(h, id);
    for (const id of PATIENTS) {
      expect((await h.call(`/api/demo/review/${id}`, { method: 'POST' })).status).toBe(200);
    }
    const all = await h.call<{ items: FindingView[] }>('/api/inbox/findings?limit=100');
    shadowCategories = [...new Set(all.body.items.map((item) => item.category))];
    // The fixture really has findings of the categories this suite plays with.
    expect(shadowCategories).toEqual(
      expect.arrayContaining(['lab_trend', 'unaddressed_symptom', 'drug_condition_conflict']),
    );
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('shows no finding card while every category is in shadow (the demo default)', async () => {
    const flags = await h.call<{ items: FindingFlagView[] }>('/api/inbox/finding-flags');
    expect(flags.body.items.every((flag) => flag.mode === 'shadow')).toBe(true);
    expect(await inbox(h)).toMatchObject({ items: [], total: 0, byPatient: {}, queued: 0 });
    const queue = await h.call<{ items: PatientQueueItem[] }>('/api/inbox/patients-queue');
    expect(queue.body.items.some((item) => item.liveFindings !== undefined)).toBe(false);
  });

  it('a live flag without a sign-off is refused and brings nothing to the inbox', async () => {
    const unsigned = await setFlag(h, { category: 'lab_trend', mode: 'live' });
    expect(unsigned.status).toBe(422);
    expect((await inbox(h)).total).toBe(0);
  });

  it('switching one category live with validatedBy brings exactly its open findings, with their evidence', async () => {
    const live = await setFlag(h, {
      category: 'lab_trend',
      mode: 'live',
      validatedBy: 'dra-castellanos',
    });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ mode: 'live', validatedBy: 'dra-castellanos' });

    const body = await inbox(h);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.category === 'lab_trend')).toBe(true);
    expect(body.items.every((item) => item.status === 'open')).toBe(true);
    expect(body.total).toBe(body.items.length);
    const trend = body.items.find((item) => item.patient.id === 'rev-0001');
    expect(trend).toMatchObject({
      severity: 'high',
      patient: { id: 'rev-0001', name: 'Rodolfo Arismendi Paz' },
    });
    expect(trend?.summary).not.toBe('');
    expect(trend?.suggestion).not.toBe('');
    // The cited evidence: verbatim quote, source document and date.
    expect(trend?.citations.map((citation) => citation.quote)).toContain('Creatinine: 1.75 mg/dL');
    for (const citation of trend?.citations ?? []) {
      expect(citation.docId).toMatch(/^Observation\//);
      expect(citation.title).not.toBe('');
      expect(Number.isNaN(Date.parse(citation.date))).toBe(false);
    }
    expect(body.byPatient).toEqual({ 'rev-0001': 1 });
    // The shadow categories stay out, in the API itself.
    for (const category of shadowCategories.filter((item) => item !== 'lab_trend')) {
      expect(body.items.some((item) => item.category === category)).toBe(false);
    }
    // One patient's cards only.
    const one = await h.call<InboxFindingList>('/api/inbox/live-findings?patientId=rev-0003');
    expect(one.body.items).toEqual([]);
  });

  it('a second live category adds its findings; the shadow one still never appears', async () => {
    expect(
      (
        await setFlag(h, {
          category: 'unaddressed_symptom',
          mode: 'live',
          validatedBy: 'dra-castellanos',
        })
      ).status,
    ).toBe(200);
    const body = await inbox(h);
    expect(new Set(body.items.map((item) => item.category))).toEqual(
      new Set(['lab_trend', 'unaddressed_symptom']),
    );
    expect(body.items.some((item) => item.category === 'drug_condition_conflict')).toBe(false);
    // Most severe first.
    const ranks = body.items.map((item) => ({ high: 0, medium: 1, low: 2 })[item.severity]);
    expect(ranks).toEqual([...ranks].sort());
  });

  it('switching a category back to shadow takes its findings out of the inbox', async () => {
    expect((await setFlag(h, { category: 'unaddressed_symptom', mode: 'shadow' })).status).toBe(
      200,
    );
    const body = await inbox(h);
    expect(body.items.some((item) => item.category === 'unaddressed_symptom')).toBe(false);
    expect(body.items.every((item) => item.category === 'lab_trend')).toBe(true);
  });

  it('another clinic never sees the cards nor can rate them (tenant isolation)', async () => {
    expect(await inbox(h, KEY_B)).toMatchObject({ items: [], total: 0, byPatient: {}, queued: 0 });
    const [card] = (await inbox(h)).items;
    if (card === undefined) throw new Error('expected a live card');
    const foreign = await h.call(`/api/inbox/findings/${card.id}/review`, {
      key: KEY_B,
      body: { verdict: 'relevant' },
    });
    expect(foreign.status).toBe(404);
    // Clinic B switching its own category live changes nothing for clinic A, and vice versa.
    expect(
      (
        await setFlag(
          h,
          { category: 'drug_condition_conflict', mode: 'live', validatedBy: 'b' },
          KEY_B,
        )
      ).status,
    ).toBe(200);
    expect((await inbox(h)).items.some((item) => item.category === 'drug_condition_conflict')).toBe(
      false,
    );
    expect((await inbox(h, KEY_B)).total).toBe(0);
  });

  it('"not relevant" needs a reason; a rating records the feedback and the card leaves the queue', async () => {
    const [card] = (await inbox(h)).items;
    if (card === undefined) throw new Error('expected a live card');
    const missing = await h.call<{ error: { fields: { path: string }[] } }>(
      `/api/inbox/findings/${card.id}/review`,
      { body: { verdict: 'not_relevant' } },
    );
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.map((field) => field.path)).toEqual(['reason']);
    expect((await inbox(h)).items.map((item) => item.id)).toContain(card.id);

    const rated = await h.call<FindingView>(`/api/inbox/findings/${card.id}/review`, {
      body: { verdict: 'not_relevant', reason: 'Expected after the contrast study' },
      headers: { 'X-FollowUp-User': 'dr-medina' },
    });
    expect(rated.status).toBe(200);
    expect(rated.body).toMatchObject({
      status: 'not_relevant',
      review: {
        verdict: 'not_relevant',
        reason: 'Expected after the contrast study',
        reviewedBy: 'dr-medina',
      },
    });
    const after = await inbox(h);
    expect(after.items.map((item) => item.id)).not.toContain(card.id);
    expect(after.byPatient[card.patient.id]).toBeUndefined();
    // The verdict counts toward the category's review in Categories.
    const flags = await h.call<{ items: FindingFlagView[] }>('/api/inbox/finding-flags');
    expect(flags.body.items.find((flag) => flag.category === 'lab_trend')?.validatedBy).toBe(
      'dra-castellanos',
    );
    const detail = await h.call<FindingView>(`/api/inbox/findings/${card.id}`);
    expect(detail.body.review?.verdict).toBe('not_relevant');
  });

  it('"relevant" and "already known" record the feedback and remove the card too', async () => {
    // Bring the symptom cards back and rate one of each.
    await setFlag(h, { category: 'unaddressed_symptom', mode: 'live' });
    const cards = (await inbox(h)).items;
    const [first] = cards;
    if (first === undefined) throw new Error('expected a live card');
    const relevant = await h.call<FindingView>(`/api/inbox/findings/${first.id}/review`, {
      body: { verdict: 'relevant' },
    });
    expect(relevant.body.review?.verdict).toBe('relevant');
    const [second] = (await inbox(h)).items;
    if (second !== undefined) {
      const known = await h.call<FindingView>(`/api/inbox/findings/${second.id}/review`, {
        body: { verdict: 'already_known' },
      });
      expect(known.body.review?.verdict).toBe('already_known');
      expect((await inbox(h)).items.map((item) => item.id)).not.toContain(second.id);
    }
    expect((await inbox(h)).items.map((item) => item.id)).not.toContain(first.id);
  });
});

/* The evaluator's lab sandbox: switching a category live there, signed off by the evaluator. */

const KEY = 'live-findings-lab-key';
const CODE = 'live-findings-lab-code';
const EMAIL = 'lab-evaluator@example.com';

function evaluatorCookie(email: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(email).digest('base64url');
  return `fue_evaluator=${Buffer.from(email, 'utf8').toString('base64url')}.${signature}`;
}

describe('live findings in the evaluator lab', () => {
  let runtime: EngineRuntime;
  let call: (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; body: unknown }>;
  const lab = labClinicId(EMAIL);

  beforeAll(async () => {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        DEMO_API_KEY: KEY,
        LLM_PROVIDER: 'fake',
        DATABASE_URL: '',
      }),
    );
    const { app }: { app: App } = createApiServer(
      runtime,
      loadApiConfig({ DEMO_ACCESS_CODE: CODE }),
    );
    const secret = deriveSessionSecret(CODE);
    call = async (path, init = {}) => {
      const response = await app.request(path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${KEY}`,
          cookie: `fue_access=${accessToken(CODE)}; ${evaluatorCookie(EMAIL, secret)}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
    };
    // A cohort patient in the evaluator's own lab clinic (never the shared demo).
    await call('/api/demo/lab/finding-flags');
    const patient = cohort.patients.find((item) => item.patientId === 'rev-0001');
    for (const entry of patient?.entries ?? []) {
      const accepted = await runtime.ingestion.accept(toClinicId(lab), entry.bundle, 'sync');
      expect(accepted.ok).toBe(true);
    }
  }, 60_000);

  afterAll(async () => {
    await runtime.close();
  });

  it('the lab starts in shadow; going live there is signed off as the evaluator, never by the body', async () => {
    const flags = (await call('/api/demo/lab/finding-flags')).body as { items: FindingFlagView[] };
    expect(flags.items.filter((flag) => flag.implemented).every((flag) => flag.enabled)).toBe(true);
    expect(flags.items.every((flag) => flag.mode === 'shadow')).toBe(true);

    const reviewed = await call('/api/demo/lab/patients/rev-0001/review', { method: 'POST' });
    expect(reviewed.status).toBe(200);
    expect(
      (reviewed.body as { findings: FindingView[] }).findings.map((item) => item.category),
    ).toContain('lab_trend');
    expect(((await call('/api/demo/lab/live-findings')).body as InboxFindingList).total).toBe(0);

    const live = await call('/api/demo/lab/finding-flags', {
      method: 'PUT',
      body: { category: 'lab_trend', enabled: true, mode: 'live', validatedBy: 'someone-else' },
    });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ mode: 'live', validatedBy: EMAIL, updatedBy: EMAIL });

    const cards = (await call('/api/demo/lab/live-findings')).body as InboxFindingList;
    expect(cards.items.map((item) => item.category)).toEqual(['lab_trend']);
    const [card] = cards.items;
    if (card === undefined) throw new Error('expected a lab card');
    const rated = await call(`/api/demo/lab/findings/${card.id}/review`, {
      body: { verdict: 'relevant' },
    });
    expect(rated.status).toBe(200);
    expect(rated.body).toMatchObject({ review: { verdict: 'relevant', reviewedBy: EMAIL } });
    expect(((await call('/api/demo/lab/live-findings')).body as InboxFindingList).total).toBe(0);
  });

  it("the lab's live switch never reaches the shared demo clinic", async () => {
    const shared = (await call('/api/inbox/finding-flags')).body as { items: FindingFlagView[] };
    expect(shared.items.every((flag) => flag.mode === 'shadow')).toBe(true);
    expect(((await call('/api/inbox/live-findings')).body as InboxFindingList).total).toBe(0);
  });

  it('every lab reviewer route needs an evaluator identity', async () => {
    // No access gate, so no evaluator: the lab is refused, the shared inbox is not.
    const anonymous = createApiServer(runtime, loadApiConfig({})).app;
    for (const [method, path] of [
      ['GET', '/api/demo/lab/finding-flags'],
      ['PUT', '/api/demo/lab/finding-flags'],
      ['GET', '/api/demo/lab/live-findings'],
      ['POST', '/api/demo/lab/findings/any/review'],
      ['POST', '/api/demo/lab/patients/rev-0001/review'],
    ] as const) {
      const response = await anonymous.request(path, {
        method,
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        ...(method === 'GET'
          ? {}
          : {
              body: JSON.stringify(
                path.endsWith('finding-flags')
                  ? { category: 'lab_trend', enabled: true, mode: 'live' }
                  : { verdict: 'relevant' },
              ),
            }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});
