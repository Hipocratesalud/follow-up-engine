import { loadReviewerCohort } from '@follow-up-engine/testkit';
import { clinicId as toClinicId } from '@follow-up-engine/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingView, InboxFindingList } from './http/reviewer-schemas.ts';
import { createHarness, type Harness } from './test/harness.ts';

/*
 * A finding reads in the viewer's UI language (Accept-Language), whatever
 * the clinic's locale it was stored in: the detectors render every locale
 * and the reviewing model (here the scripted one, through the real gateway
 * and loop) returns both. A result's canonical line follows the reader too;
 * a note's quote never changes. Findings stored before keep working.
 */

const cohort = loadReviewerCohort();
/** English words that must never show in a Spanish finding (quotes from notes aside). */
const ENGLISH = /\b(the|with|and|over|Consider|rising|falling|results|notes|visit|review)\b/;

async function sendPatient(h: Harness, id: string): Promise<void> {
  const patient = cohort.patients.find((item) => item.patientId === id);
  for (const entry of patient?.entries ?? []) {
    expect((await h.call('/fhir?sync=true', { body: entry.bundle, fhir: true })).status).toBe(200);
  }
}

function inLanguage(language: 'en' | 'es') {
  return { headers: { 'accept-language': language } };
}

describe('finding texts in the viewer language', () => {
  let h: Harness;
  let all: FindingView[];

  beforeAll(async () => {
    h = await createHarness();
    for (const id of ['rev-0001', 'rev-0003']) {
      await sendPatient(h, id);
      expect((await h.call(`/api/demo/review/${id}`, { method: 'POST' })).status).toBe(200);
    }
    all = (await h.call<{ items: FindingView[] }>('/api/inbox/findings?limit=100')).body.items;
    expect(all.length).toBeGreaterThan(2);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('an LLM (scripted) finding of an English clinic reads in Spanish for a Spanish viewer', async () => {
    const trend = all.find((item) => item.category === 'lab_trend');
    if (trend === undefined) throw new Error('no lab trend');
    // Written by the reviewing model through the gateway, not stored as a bare detector signal.
    expect(trend.modelId).toBe('fake:fake-reviewer');
    expect(trend.origin).toBe('confirmed');

    const en = (await h.call<FindingView>(`/api/inbox/findings/${trend.id}`, inLanguage('en')))
      .body;
    expect(en.summary).toMatch(/^Creatinine rising over the last/);
    expect(en.suggestion).toMatch(/^Consider assessing renal function/);
    expect(en.citations.map((citation) => citation.quote)).toContain('Creatinine: 1.75 mg/dL');

    const es = (await h.call<FindingView>(`/api/inbox/findings/${trend.id}`, inLanguage('es')))
      .body;
    expect(es.summary).toMatch(/^Creatinina en ascenso en los últimos/);
    expect(es.suggestion).toMatch(/^Considera evaluar la función renal/);
    expect(es.rationale).not.toMatch(ENGLISH);
    expect(es.categoryLabel).not.toBe(en.categoryLabel);
    // The engine's canonical result line follows the reader; the value stays as recorded.
    expect(es.citations.map((citation) => citation.quote)).toContain('Creatinina: 1,75 mg/dL');
    // Spanish numbers in the generated text: "1,05 → 1,1 → 1,4 → 1,75".
    expect(es.summary).toContain('(1,05 → 1,1 → 1,4 → 1,75 mg/dL)');
    expect(en.summary).toContain('(1.05 → 1.1 → 1.4 → 1.75 mg/dL)');
    expect(es.trend?.label).toBe('Creatinina');
  });

  it('no Spanish finding of the batch review has English prose nor ISO dates (note quotes aside)', async () => {
    const page = await h.call<{ items: FindingView[] }>(
      '/api/inbox/findings?limit=100',
      inLanguage('es'),
    );
    expect(page.body.items.length).toBe(all.length);
    for (const item of page.body.items) {
      const prose = [
        item.summary,
        item.rationale,
        item.suggestion,
        item.categoryLabel,
        ...item.citations.map((citation) => citation.title),
        ...item.citations.filter((citation) => citation.kind === 'result').map((c) => c.quote),
      ].join(' | ');
      expect(prose, item.category).not.toMatch(ENGLISH);
      // Spanish decimals: never "1.75" in what the engine writes (drug names are the record's own).
      const generated = [
        ...([
          'lab_trend',
          'vital_trend',
          'abnormal_result_no_followup',
          'utilization_change',
        ].includes(item.category)
          ? [item.summary, item.rationale]
          : []),
        ...item.citations.filter((citation) => citation.kind === 'result').map((c) => c.quote),
      ].join(' | ');
      expect(generated, item.category).not.toMatch(/\d\.\d/);
      // Dates in sentences as the reader writes them, never ISO.
      expect(prose, item.category).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it('the live inbox cards follow the viewer language too', async () => {
    await h.call('/api/inbox/finding-flags', {
      method: 'PUT',
      body: { category: 'lab_trend', enabled: true, mode: 'live', validatedBy: 'dra-castellanos' },
    });
    const es = await h.call<InboxFindingList>('/api/inbox/live-findings', inLanguage('es'));
    expect(es.body.items[0]?.summary).toMatch(/^Creatinina en ascenso/);
    const en = await h.call<InboxFindingList>('/api/inbox/live-findings', inLanguage('en'));
    expect(en.body.items[0]?.summary).toMatch(/^Creatinine rising/);
  });

  it('a detector finding stored before texts existed is rendered again in the reader language', async () => {
    const source = await h.runtime.reviewer.getFinding(
      toClinicId('clinic-demo'),
      all.find((item) => item.category === 'lab_trend')?.id ?? '',
    );
    if (source === undefined) throw new Error('no stored finding');
    const legacy = { ...source, id: 'legacy-trend' };
    delete (legacy as { texts?: unknown }).texts;
    await h.runtime.storage.stores.clinicalFindings.create(toClinicId('clinic-demo'), legacy);
    const es = await h.call<FindingView>('/api/inbox/findings/legacy-trend', inLanguage('es'));
    expect(es.body.summary).toMatch(/^Creatinina en ascenso/);

    // A model's own finding with no translation keeps its stored words.
    const added = { ...legacy, id: 'legacy-added', origin: 'added' as const, dedupKey: 'x|y' };
    await h.runtime.storage.stores.clinicalFindings.create(toClinicId('clinic-demo'), added);
    const kept = await h.call<FindingView>('/api/inbox/findings/legacy-added', inLanguage('es'));
    expect(kept.body.summary).toBe(source.summary);
  });
});
