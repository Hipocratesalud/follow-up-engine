import { createRuntime, type EngineRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../http/app.ts';
import type { App } from '../http/context.ts';
import type { CaseDetail, CaseView, PatientDetail } from '../http/schemas.ts';
import type { DocumentRefView, PatientDocumentView, ReasonWhyView } from '../http/why-schemas.ts';
import { EN } from '../i18n/en.ts';
import { seedSyntheticClinic } from '../test/seed.ts';

/**
 * Exact status text per protocol, in English (the suite never asks for
 * Spanish): diabetes and hypertension have a sign-off package
 * (docs/protocols/signoff), every other protocol is still a plain draft;
 * none is validated yet.
 */
const PROTOCOL_STATUS_TEXT: Readonly<Record<string, string>> = {
  diabetes: EN.why.readyForSignoff,
  hypertension: EN.why.readyForSignoff,
  pregnancy: EN.why.draft,
  treatment_followup: EN.why.draft,
  hypothyroidism: EN.why.draft,
  dyslipidemia: EN.why.draft,
  chronic_kidney_disease: EN.why.draft,
};

/*
 * HIP-142 "Why this?" over the whole synthetic clinic: every reason of every
 * case explains its due date and what would fulfill it; every document it
 * cites is one of the patient's own (it is in the patient's "View
 * documents" drawer), never invented; protocol reasons say what enrolled
 * the patient, cadence reasons the visits of the pattern. English by
 * default, Spanish with Accept-Language.
 */

const KEY = 'why-key';

function cited(why: ReasonWhyView): DocumentRefView[] {
  return [
    ...(why.due.anchor === undefined ? [] : [why.due.anchor]),
    ...(why.due.tooEarly === undefined ? [] : [why.due.tooEarly]),
    ...(why.closedBy === undefined ? [] : [why.closedBy]),
    ...(why.plan?.note === undefined ? [] : [why.plan.note]),
    ...(why.protocol?.enrollment.evidence ?? []),
    ...(why.protocol?.enrollment.activeTreatment === undefined
      ? []
      : [why.protocol.enrollment.activeTreatment]),
    ...(why.protocol?.enrollment.endedBy === undefined ? [] : [why.protocol.enrollment.endedBy]),
  ];
}

describe('"Why this?" evidence in the inbox API', () => {
  let runtime: EngineRuntime;
  let app: App;
  const details: CaseDetail[] = [];
  const documents = new Map<string, PatientDocumentView[]>();

  async function get<T>(path: string, language?: string): Promise<T> {
    const response = await app.request(path, {
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(language === undefined ? {} : { 'accept-language': language }),
      },
    });
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  }

  beforeAll(async () => {
    runtime = await createRuntime(loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent' }));
    await seedSyntheticClinic(runtime, { apiKey: KEY });
    app = createApp(runtime, { corsOrigins: [] });
    const page = await get<{ items: CaseView[] }>('/api/inbox/cases?view=all&limit=200');
    for (const item of page.items) {
      details.push(await get<CaseDetail>(`/api/inbox/cases/${item.id}`));
      if (!documents.has(item.patient.id)) {
        const list = await get<{ items: PatientDocumentView[] }>(
          `/api/inbox/patients/${item.patient.id}/documents`,
        );
        documents.set(item.patient.id, list.items);
      }
    }
  }, 120_000);
  afterAll(async () => {
    await runtime.close();
  });

  it('explains every reason of every case: due date math and what would fulfill it', () => {
    const reasons = details.flatMap((detail) => detail.reasons);
    expect(reasons.length).toBeGreaterThan(50);
    for (const reason of reasons) {
      const why = reason.why;
      expect(why, reason.expectationId).toBeDefined();
      if (why === undefined) continue;
      expect(why.layer).toBe(reason.layer);
      expect(why.due.dueAt).toBe(reason.dueAt);
      expect(why.due.text).toMatch(/^Due /);
      expect(why.due.basisText).not.toBe('');
      expect(why.fulfilledBy.text).not.toBe('');
      if (why.due.anchor !== undefined && why.due.days !== undefined && why.due.anchorAt) {
        // The math adds up: anchor + days = due date (rounded to whole days).
        const days = (Date.parse(why.due.dueAt) - Date.parse(why.due.anchorAt)) / 86_400_000;
        expect(Math.abs(days - why.due.days)).toBeLessThan(1);
      }
    }
  });

  it('cites only the patient’s own documents, all of them in the documents drawer', () => {
    for (const detail of details) {
      const own = new Set(
        (documents.get(detail.patient.id) ?? []).map((doc) => `${doc.resourceType}/${doc.id}`),
      );
      for (const reason of detail.reasons) {
        for (const doc of reason.why === undefined ? [] : cited(reason.why)) {
          expect(own, `${detail.id} cites ${doc.resourceType}/${doc.id}`).toContain(
            `${doc.resourceType}/${doc.id}`,
          );
        }
      }
    }
  });

  it('says what enrolled the patient in the protocol, with the protocol version and status', () => {
    const protocolReasons = details
      .flatMap((detail) => detail.reasons)
      .filter((reason) => reason.layer === 'protocol');
    expect(protocolReasons.length).toBeGreaterThan(10);
    for (const reason of protocolReasons) {
      const protocol = reason.why?.protocol;
      expect(protocol, reason.expectationId).toBeDefined();
      expect(protocol?.id).toBe(reason.protocol?.id);
      expect(protocol?.title).toContain(`v${reason.protocol?.version ?? ''}`);
      expect(protocol?.statusText).toBe(PROTOCOL_STATUS_TEXT[protocol?.id ?? '']);
      expect(protocol?.scheduleText).toBeTruthy();
      expect(protocol?.enrollment.text).not.toBe('');
      if (protocol?.enrollment.episode === 'active') {
        expect(protocol.enrollment.evidence.length).toBeGreaterThan(0);
        expect(protocol.enrollment.condition?.code).toBeTruthy();
      }
    }
    // The clinic has patients enrolled by a coded diagnosis.
    const bases = new Set(protocolReasons.map((reason) => reason.why?.protocol?.enrollment.basis));
    expect(bases).toContain('diagnosis');
  });

  it("shows the doctor's words in the note and the visit history behind a cadence break", () => {
    const reasons = details.flatMap((detail) => detail.reasons);
    for (const reason of reasons.filter((item) => item.layer === 'doctor_plan')) {
      expect(reason.why?.plan?.quote).toBe(reason.evidence?.quote);
      expect(reason.why?.plan?.noteExcerpt).toBeTruthy();
      expect(reason.why?.due.basis).toBe('plan_date');
    }
    const cadence = reasons.filter((item) => item.layer === 'cadence');
    expect(cadence.length).toBeGreaterThan(0);
    for (const reason of cadence) {
      const pattern = reason.why?.cadence;
      expect(pattern?.visits.filter((visit) => visit.inPattern).length).toBeGreaterThanOrEqual(2);
      expect(pattern?.usualIntervalDays).toBeGreaterThan(0);
      expect(pattern?.expectedBy).toBe(reason.dueAt);
    }
  });

  it('lists every document of a patient oldest first, notes with their full text', () => {
    for (const items of documents.values()) {
      const times = items.map((item) => Date.parse(item.at));
      expect([...times].sort((left, right) => left - right)).toEqual(times);
      for (const note of items.filter((item) => item.kind === 'note')) {
        expect(note.text).toBeTruthy();
      }
    }
    const kinds = new Set([...documents.values()].flat().map((item) => item.kind));
    for (const kind of ['note', 'order', 'result', 'prescription', 'visit', 'diagnosis']) {
      expect(kinds).toContain(kind);
    }
  });

  it('answers the patient page with "Why this?" on every expectation, and in Spanish on request', async () => {
    const patient = details[0]?.patient.id ?? '';
    const english = await get<PatientDetail>(`/api/inbox/patients/${patient}`);
    expect(english.expectations.length).toBeGreaterThan(0);
    for (const expectation of english.expectations) {
      expect(expectation.why?.due.dueAt).toBe(expectation.dueAt);
    }
    const spanish = await get<PatientDetail>(`/api/inbox/patients/${patient}`, 'es');
    expect(spanish.expectations[0]?.why?.due.text).toMatch(/^Vence el /);
    const caseId = details[0]?.id ?? '';
    const detail = await get<CaseDetail>(`/api/inbox/cases/${caseId}`, 'es');
    expect(detail.reasons[0]?.why?.fulfilledBy.text).not.toMatch(/^A /);
    const docs = await get<{ items: PatientDocumentView[] }>(
      `/api/inbox/patients/${patient}/documents`,
      'es',
    );
    expect(docs.items.some((item) => item.kindLabel === 'Nota clínica')).toBe(true);
  });

  it('answers 404 for the documents of an unknown patient', async () => {
    const response = await app.request('/api/inbox/patients/nobody/documents', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(404);
  });
});
