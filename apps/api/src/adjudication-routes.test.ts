import { clinicId, expectationId } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { Worker } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdjudicationList } from './http/adjudication-schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/** PRD V2 workstream E: the adjudicator's decisions in the inbox API, and the doctor's override. */

const NOW = new Date('2026-01-05T12:00:00Z');
const PATIENT = 'pat-adj-1';

for (const storage of STORAGES) {
  describe(`adjudication API (${storage})`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness({ storage });
    });
    afterEach(async () => {
      await h.close();
    });

    async function seedDecision(): Promise<AdjudicationList> {
      const bundle = buildConsultationBundle({
        consultationId: `c-${PATIENT}`,
        patient: { id: PATIENT, name: 'Paciente Prueba' },
        specialty: 'diabetology',
        occurredAt: NOW,
        noteText: 'Paciente con DM2. Plan: control en 2 semanas.',
      });
      expect((await h.call('/fhir?sync=true', { body: bundle, fhir: true })).status).toBe(200);
      // The demo clinic runs the adjudicator in shadow: the ambiguous item queued a job.
      expect((await new Worker(h.runtime).runJobs()).completed).toBeGreaterThanOrEqual(1);
      const listed = await h.call<AdjudicationList>(
        `/api/inbox/adjudications?patientId=${PATIENT}`,
      );
      expect(listed.status).toBe(200);
      return listed.body;
    }

    it('lists the decision with its reasons, quotes, probability and provenance', async () => {
      const list = await seedDecision();
      expect(list.settings).toEqual({ mode: 'shadow', minConfidence: 0.4, maxConfidence: 0.75 });
      expect(list.items).toHaveLength(1);
      const [item] = list.items;
      expect(item).toMatchObject({
        patientId: PATIENT,
        decision: 'open',
        decisionLabel: 'the note asks for it',
        mode: 'shadow',
        applied: false,
        provider: 'fake',
        model: 'fake-adjudicator',
        promptVersion: 'adjudicator@1',
        costUsd: 0,
      });
      expect(item?.quotes[0]?.quote).toContain('control en 2 semanas');
      expect(item?.reasons.map((reason) => reason.code)).toContain('explicit_instruction');

      const spanish = await h.call<AdjudicationList>(
        `/api/inbox/adjudications?patientId=${PATIENT}`,
        { headers: { 'Accept-Language': 'es' } },
      );
      expect(spanish.body.items[0]?.decisionLabel).toBe('la nota lo pide');
      expect(spanish.body.items[0]?.rationale).toMatch(/indicación/u);

      // Another clinic sees nothing, and its adjudicator is off.
      const other = await h.call<AdjudicationList>('/api/inbox/adjudications', { key: KEY_B });
      expect(other.body).toEqual({
        items: [],
        settings: { mode: 'off', minConfidence: 0.4, maxConfidence: 0.75 },
      });
    });

    it('a doctor overrides once: discard rejects the item', async () => {
      const [item] = (await seedDecision()).items;
      const id = item?.id ?? '';
      expect(
        (
          await h.call(`/api/inbox/adjudications/${id}/override`, {
            key: KEY_B,
            body: { decision: 'discard' },
          })
        ).status,
      ).toBe(404);
      const response = await h.call<{ adjudication: AdjudicationList['items'][number] }>(
        `/api/inbox/adjudications/${id}/override`,
        { body: { decision: 'discard', note: 'Not in the plan' } },
      );
      expect(response.status).toBe(200);
      expect(response.body.adjudication.override).toMatchObject({
        decision: 'discard',
        decisionLabel: 'the note does not ask for it',
        note: 'Not in the plan',
      });
      const expectation = await h.runtime.storage.stores.expectations.get(
        clinicId('clinic-demo'),
        expectationId(item?.expectationId ?? ''),
      );
      expect(expectation).toMatchObject({
        status: 'cancelled',
        closedReason: 'rejected_by_clinician',
      });
      const again = await h.call(`/api/inbox/adjudications/${id}/override`, {
        body: { decision: 'open' },
      });
      expect(again.status).toBe(409);
      const invalid = await h.call(`/api/inbox/adjudications/${id}/override`, {
        body: { decision: 'maybe' },
      });
      expect(invalid.status).toBe(422);
    });
  });
}
