import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PatientQueueItem,
  PatientQueuePage,
  PlanItemReviewResponse,
} from './http/patient-queue-schemas.ts';
import type { CaseDetail, InboxStats, PatientDetail } from './http/schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/*
 * HIP-141 over HTTP: the patient queue (one card per patient, actions per
 * case, one contact request per patient and window) and the review of the
 * plan items the AI read (confirm, correct, reject). Memory, and Postgres
 * when DATABASE_URL is set.
 */

const PATIENT = 'pat-queue-ana';

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string }[];
  };
}

/** A visit whose note asks for a control in two weeks, with an HbA1c ordered. */
async function consult(h: Harness, patient: string, name: string): Promise<void> {
  const clock = await h.call<{ now: string }>('/api/demo/clock');
  const bundle = buildConsultationBundle({
    consultationId: `cons-${patient}`,
    patient: { id: patient, name },
    specialty: 'internal_medicine',
    occurredAt: new Date(clock.body.now),
    noteText: 'Paciente estable. Se solicita HbA1c. Control en 2 semanas.',
    orders: [{ loinc: '4548-4', display: 'HbA1c' }],
  });
  const response = await h.call('/fhir?sync=true', { body: bundle, fhir: true });
  expect(response.status).toBe(200);
}

describe.each(STORAGES)('patient queue and plan item review (%s)', (storage) => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({ storage });
    await consult(h, PATIENT, 'Ana Queue Mora');
    await consult(h, 'pat-queue-bruno', 'Bruno Queue Paz');
    // Day 16: the control (due day 14) and the HbA1c result (due day 15) are overdue.
    await h.call('/api/demo/clock/advance', { body: { days: 16 } });
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists one card per patient with every case, counting patients and cases', async () => {
    const { status, body } = await h.call<PatientQueuePage>('/api/inbox/patients-queue');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.totalCases).toBe(4);
    const ana = body.items.find((item) => item.patient.id === PATIENT);
    expect(ana).toMatchObject({ caseCount: 2, reasonCount: 2, origin: 'live' });
    expect(ana?.cases.map((item) => item.patient.id)).toEqual([PATIENT, PATIENT]);
    expect(ana?.priority).toBe(Math.max(...(ana?.cases ?? []).map((item) => item.priority)));
    expect(ana?.nextAction.caseId).toBe(ana?.cases[0]?.id);
    expect(new Set(ana?.layers)).toEqual(new Set(['doctor_plan', 'universal']));
    // The per-case list still answers per case.
    const cases = await h.call<{ total: number }>('/api/inbox/cases');
    expect(cases.body.total).toBe(4);
    const stats = await h.call<InboxStats>('/api/inbox/stats');
    expect(stats.body).toMatchObject({ activeCases: 4, activePatients: 2 });
  });

  it('pages by patient, searches by name and filters by owner', async () => {
    const first = await h.call<PatientQueuePage>('/api/inbox/patients-queue?limit=1');
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]?.caseCount).toBe(2);
    const second = await h.call<PatientQueuePage>(
      `/api/inbox/patients-queue?limit=1&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeUndefined();
    expect(
      new Set([...first.body.items, ...second.body.items].map((item) => item.patient.id)).size,
    ).toBe(2);
    const search = await h.call<PatientQueuePage>('/api/inbox/patients-queue?q=ana%20mora');
    expect(search.body.items.map((item) => item.patient.id)).toEqual([PATIENT]);
    expect(search.body.total).toBe(1);
    const owner = search.body.items[0]?.cases[0]?.assigneeId ?? '';
    const owned = await h.call<PatientQueuePage>(
      `/api/inbox/patients-queue?assignee=${encodeURIComponent(owner)}`,
    );
    expect(owned.body.items.every((item) => item.cases.every((c) => c.assigneeId === owner))).toBe(
      true,
    );
    const garbage = await h.call<ErrorBody>('/api/inbox/patients-queue?cursor=garbage');
    expect(garbage.status).toBe(400);
  });

  it('keeps actions per case and asks for contact once per patient and window', async () => {
    const card = await h.call<PatientQueueItem>(`/api/inbox/patients-queue/${PATIENT}`);
    expect(card.status).toBe(200);
    const [primary, other] = card.body.cases;
    const contact = await h.call<PatientQueueItem>(
      `/api/inbox/patients-queue/${PATIENT}/request-contact`,
      { body: { note: 'Prefiere la tarde' } },
    );
    expect(contact.status).toBe(200);
    expect(contact.body.cases.map((item) => item.status)).toEqual(['notified', 'notified']);
    expect(contact.body.patientContact.lastContactAt).toBeDefined();
    const again = await h.call<ErrorBody>(`/api/inbox/patients-queue/${PATIENT}/request-contact`, {
      body: {},
    });
    expect(again.status).toBe(409);
    const perCase = await h.call<ErrorBody>(`/api/inbox/cases/${other?.id ?? ''}/actions`, {
      body: { action: 'notify' },
    });
    expect(perCase.status).toBe(409);
    // The other case's history shows the request it shares.
    const detail = await h.call<CaseDetail>(`/api/inbox/cases/${other?.id ?? ''}`);
    expect(detail.body.timeline.map((entry) => entry.type)).toContain('patient_contact_requested');
    // Dismissing one case leaves the other on the card.
    const dismissed = await h.call<CaseDetail>(`/api/inbox/cases/${other?.id ?? ''}/actions`, {
      body: { action: 'dismiss', reason: 'already_done' },
    });
    expect(dismissed.status).toBe(200);
    const after = await h.call<PatientQueueItem>(`/api/inbox/patients-queue/${PATIENT}`);
    expect(after.body.caseCount).toBe(1);
    expect(after.body.cases.map((item) => [item.id, item.status])).toEqual([
      [primary?.id, 'notified'],
      [other?.id, 'dismissed'],
    ]);
    const unknown = await h.call<ErrorBody>('/api/inbox/patients-queue/nobody/request-contact', {
      body: {},
    });
    expect(unknown.status).toBe(404);
    expect((await h.call('/api/inbox/patients-queue/nobody')).status).toBe(404);
  });

  it('confirms, corrects and rejects the plan item the AI read, each audited', async () => {
    const patient = await h.call<PatientDetail>(`/api/inbox/patients/${PATIENT}`);
    const item = patient.body.expectations.find((e) => e.layer === 'doctor_plan');
    expect(item?.planItem).toEqual({
      kind: 'follow_up_visit',
      kindLabel: 'Follow-up visit',
      review: 'pending',
      actionable: true,
    });
    const base = `/api/inbox/plan-items/${item?.id ?? ''}`;
    const confirmed = await h.call<PlanItemReviewResponse>(`${base}/confirm`, {
      method: 'POST',
      headers: { 'X-FollowUp-User': 'dra-mora' },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.expectation.planItem).toMatchObject({
      review: 'confirmed',
      confirmedBy: 'dra-mora',
      actionable: true,
    });
    // The reason on the case carries the same review.
    const card = await h.call<PatientQueueItem>(`/api/inbox/patients-queue/${PATIENT}`);
    const planCase = card.body.cases.find((c) =>
      c.reasons.some((reason) => reason.expectationId === item?.id),
    );
    expect(planCase?.reasons[0]?.planItem?.review).toBe('confirmed');

    const nothing = await h.call<ErrorBody>(`${base}/correct`, { body: {} });
    expect(nothing.status).toBe(422);
    const badDate = await h.call<ErrorBody>(`${base}/correct`, { body: { dueDate: '2026-13-45' } });
    expect(badDate.status).toBe(422);
    const corrected = await h.call<PlanItemReviewResponse>(`${base}/correct`, {
      body: { kind: 'lab' },
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.expectation).toMatchObject({
      status: 'superseded',
      closedReason: 'Corrected by a clinician',
      planItem: { review: 'corrected', actionable: false },
    });
    // Still overdue: the correction takes its place in the case.
    expect(corrected.body.replacement).toMatchObject({
      status: 'expired',
      planItem: { kind: 'lab', review: 'confirmed', correctionOf: item?.id, actionable: true },
    });
    expect(corrected.body.casesResolved).toEqual([]);
    expect((await h.call<ErrorBody>(`${base}/reject`, { method: 'POST' })).status).toBe(409);

    const replacement = corrected.body.replacement?.id ?? '';
    const rejected = await h.call<PlanItemReviewResponse>(
      `/api/inbox/plan-items/${replacement}/reject`,
      { method: 'POST' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.expectation.planItem?.review).toBe('rejected');
    expect(rejected.body.casesResolved).toEqual([planCase?.id]);
    const caseDetail = await h.call<CaseDetail>(`/api/inbox/cases/${planCase?.id ?? ''}`);
    expect(caseDetail.body.status).toBe('resolved');
    expect(caseDetail.body.timeline.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['plan_item_confirmed', 'plan_item_corrected', 'plan_item_rejected']),
    );
    expect(caseDetail.body.timeline.find((e) => e.type === 'plan_item_corrected')?.label).toBe(
      'Plan item corrected: lab test',
    );

    // Not a plan item, unknown, or another clinic's: refused.
    const lab = patient.body.expectations.find((e) => e.layer === 'universal');
    const notPlan = await h.call<ErrorBody>(`/api/inbox/plan-items/${lab?.id ?? ''}/confirm`, {
      method: 'POST',
    });
    expect(notPlan.status).toBe(422);
    expect(notPlan.body.error.fields?.[0]?.path).toBe('expectationId');
    expect((await h.call('/api/inbox/plan-items/nope/confirm', { method: 'POST' })).status).toBe(
      404,
    );
    expect((await h.call(`${base}/confirm`, { method: 'POST', key: KEY_B })).status).toBe(404);
    expect((await h.call(`/api/inbox/patients-queue/${PATIENT}`, { key: KEY_B })).status).toBe(404);
  });
});
