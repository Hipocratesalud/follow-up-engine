import { type ClinicalFinding, clinicId as toClinicId, patientId } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { aClinicalFinding } from '@follow-up-engine/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboxFindingList } from './http/reviewer-schemas.ts';
import { createHarness, type Harness } from './test/harness.ts';

/*
 * The doctor's finding cards follow the patient list's own filters (a
 * condition's protocol, the owner, the text search): filtering by diabetes
 * hides the hypertensive patient's findings. And a finding the model wrote
 * in one language only reaches readers of the other, labeled, until its
 * translation arrives.
 */

const CLINIC = toClinicId('clinic-demo');
const DIABETIC = 'pat-cards-diabetes';
const HYPERTENSIVE = 'pat-cards-hypertension';

function liveFinding(patient: string, overrides: Partial<ClinicalFinding> = {}): ClinicalFinding {
  return aClinicalFinding(CLINIC, {
    id: `finding-${patient}`,
    patientId: patientId(patient),
    mode: 'live',
    dedupKey: `lab_trend|${patient}`,
    ...overrides,
  });
}

describe('finding cards and the patient list filters', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    const now = (await h.call<{ now: string }>('/api/demo/clock')).body.now;
    for (const [id, name, icd10] of [
      [DIABETIC, 'Zeta Tarjeta Diabetes', 'E11'],
      [HYPERTENSIVE, 'Zeta Tarjeta Hipertension', 'I10'],
    ] as const) {
      const bundle = buildConsultationBundle({
        consultationId: `cons-${id}`,
        patient: { id, name },
        specialty: 'internal_medicine',
        occurredAt: new Date(now),
        noteText: 'Paciente estable, sin cambios.',
        diagnoses: [{ icd10, verification: 'confirmed' }],
      });
      expect((await h.call('/fhir?sync=true', { body: bundle, fhir: true })).status).toBe(200);
    }
    // Both protocols' first items come due: each patient gets a protocol case.
    await h.call('/api/demo/clock/advance', { body: { days: 200 } });
    await h.call('/api/inbox/finding-flags', {
      method: 'PUT',
      body: { category: 'lab_trend', enabled: true, mode: 'live', validatedBy: 'dra-castellanos' },
    });
    await h.runtime.storage.unitOfWork.withTransaction(CLINIC, async (stores) => {
      await stores.clinicalFindings.create(CLINIC, liveFinding(DIABETIC));
      await stores.clinicalFindings.create(
        CLINIC,
        liveFinding(HYPERTENSIVE, {
          // Written in Spanish only by the model: no English yet.
          texts: {
            es: {
              summary: 'Creatinina en ascenso en los últimos 3 resultados',
              rationale: 'Tres resultados seguidos empeoran.',
              suggestion: 'Considera evaluar la función renal.',
            },
          },
        }),
      );
    });
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  const patientsOf = (body: InboxFindingList) => body.items.map((item) => item.patient.id).sort();

  it('without filters, every live card', async () => {
    const all = await h.call<InboxFindingList>('/api/inbox/live-findings');
    expect(patientsOf(all.body)).toEqual([DIABETIC, HYPERTENSIVE].sort());
  });

  it('filtering by the diabetes protocol hides the hypertensive patient, and the reverse', async () => {
    const queue = await h.call<{ items: { patient: { id: string } }[] }>(
      '/api/inbox/patients-queue?q=zeta%20tarjeta&protocol=diabetes',
    );
    expect(queue.body.items.map((item) => item.patient.id)).toEqual([DIABETIC]);
    const diabetes = await h.call<InboxFindingList>('/api/inbox/live-findings?protocol=diabetes');
    expect(patientsOf(diabetes.body)).toEqual([DIABETIC]);
    expect(diabetes.body.byPatient).toEqual({ [DIABETIC]: 1 });
    const hypertension = await h.call<InboxFindingList>(
      '/api/inbox/live-findings?protocol=hypertension',
    );
    expect(patientsOf(hypertension.body)).toEqual([HYPERTENSIVE]);
  });

  it('follows the text search and the owner filter like the list', async () => {
    const search = await h.call<InboxFindingList>(
      '/api/inbox/live-findings?q=tarjeta%20hipertension',
    );
    expect(patientsOf(search.body)).toEqual([HYPERTENSIVE]);
    const nobody = await h.call<InboxFindingList>('/api/inbox/live-findings?q=no%20such%20person');
    expect(nobody.body.items).toEqual([]);
    const owners = await h.call<{ items: { id: string }[] }>('/api/inbox/owners');
    const unknownOwner = await h.call<InboxFindingList>(
      '/api/inbox/live-findings?assignee=owner-that-does-not-exist',
    );
    expect(unknownOwner.body.items).toEqual([]);
    for (const owner of owners.body.items) {
      const queue = await h.call<{ items: { patient: { id: string } }[] }>(
        `/api/inbox/patients-queue?assignee=${encodeURIComponent(owner.id)}&limit=200`,
      );
      const listed = new Set(queue.body.items.map((item) => item.patient.id));
      const cards = await h.call<InboxFindingList>(
        `/api/inbox/live-findings?assignee=${encodeURIComponent(owner.id)}`,
      );
      expect(cards.body.items.every((item) => listed.has(item.patient.id))).toBe(true);
    }
  });

  it('a Spanish-only finding reaches English readers labeled, until its translation arrives', async () => {
    const card = (body: InboxFindingList) =>
      body.items.find((item) => item.patient.id === HYPERTENSIVE);
    const en = await h.call<InboxFindingList>('/api/inbox/live-findings', {
      headers: { 'accept-language': 'en' },
    });
    expect(card(en.body)).toMatchObject({
      summary: 'Creatinina en ascenso en los últimos 3 resultados',
      untranslated: true,
    });
    const es = await h.call<InboxFindingList>('/api/inbox/live-findings', {
      headers: { 'accept-language': 'es' },
    });
    expect(card(es.body)?.untranslated).toBeUndefined();

    // The translation job's write: the label goes away.
    await h.runtime.storage.unitOfWork.withTransaction(CLINIC, async (stores) => {
      const current = await stores.clinicalFindings.get(CLINIC, `finding-${HYPERTENSIVE}`);
      await stores.clinicalFindings.setTexts(CLINIC, `finding-${HYPERTENSIVE}`, {
        ...current?.texts,
        en: {
          summary: 'Creatinine rising over the last 3 results',
          rationale: 'Three results in a row got worse.',
          suggestion: 'Consider assessing renal function.',
        },
      });
    });
    const after = await h.call<InboxFindingList>('/api/inbox/live-findings', {
      headers: { 'accept-language': 'en' },
    });
    expect(card(after.body)).toMatchObject({
      summary: 'Creatinine rising over the last 3 results',
    });
    expect(card(after.body)?.untranslated).toBeUndefined();
  });
});
