import {
  clinicId as toClinicId,
  type Expectation,
  expectationId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import type { Task } from '@follow-up-engine/fhir';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PatientDetail } from './http/schemas.ts';
import { messagesFor } from './i18n/index.ts';
import { createHarness, type Harness, KEY_A, STORAGES } from './test/harness.ts';

/*
 * A doctor's-plan glucose test folded into the order of its visit
 * (`covered_by_order`) whose order the delivery then cancelled reads
 * `pregnancy_ended` in the inbox's patient view and in its FHIR Task, while
 * the stored closure stays the original one. One whose order came back
 * keeps reading `covered_by_order`.
 */

const PATIENT = 'reclassified-closure-patient';
const CLINIC = toClinicId('clinic-demo');
const CLOSED_AT = new Date('2026-04-06T12:00:00.000Z');
const RECLASSIFIED_AT = new Date('2026-08-08T12:00:00.000Z');

function planItem(id: string, overrides: Partial<Expectation> = {}): Expectation {
  return {
    id: expectationId(id),
    clinicId: CLINIC,
    patientId: toPatientId(PATIENT),
    idempotencyKey: `DocumentReference/prenatal-24-note#doctor_plan_followup#${id}`,
    ruleId: 'doctor_plan_followup',
    ruleVersion: '1.0.0',
    layer: 'doctor_plan',
    source: { resourceType: 'DocumentReference', id: 'prenatal-24-note' },
    matchKey: 'loinc:1558-6',
    dueAt: new Date('2026-04-20T12:00:00.000Z'),
    status: 'cancelled',
    closedReason: 'covered_by_order',
    closedAt: CLOSED_AT,
    closedBy: { resourceType: 'ServiceRequest', id: `${id}-sr` },
    origin: 'live',
    reason: { code: 'doctor_plan_followup', label: 'Seguimiento indicado por el médico' },
    evidence: { quote: 'curva de tolerancia a la glucosa', sourceDocumentId: 'prenatal-24-note' },
    createdAt: CLOSED_AT,
    updatedAt: CLOSED_AT,
    ...overrides,
  };
}

const RECLASSIFIED = planItem('exp-curve-dropped', {
  reclassification: {
    closedReason: 'pregnancy_ended',
    at: RECLASSIFIED_AT,
    by: { resourceType: 'Condition', id: 'puerperal-dx-1' },
  },
  updatedAt: RECLASSIFIED_AT,
});
const DONE = planItem('exp-curve-done');

for (const storage of STORAGES) {
  describe(`a reclassified closure in the inbox and FHIR (${storage})`, () => {
    let h: Harness;

    beforeAll(async () => {
      h = await createHarness({ storage });
      await h.call('/fhir/Patient', {
        method: 'POST',
        fhir: true,
        key: KEY_A,
        body: { resourceType: 'Patient', id: PATIENT, name: [{ text: 'Paciente Sintética' }] },
      });
      for (const expectation of [RECLASSIFIED, DONE]) {
        await h.runtime.storage.stores.expectations.upsertByIdempotencyKey(CLINIC, expectation);
      }
    });

    afterAll(async () => {
      await h.close();
    });

    it.each(['en', 'es'] as const)(
      'the patient view labels it as it reads now (%s)',
      async (language) => {
        const { status, body } = await h.call<PatientDetail>(`/api/inbox/patients/${PATIENT}`, {
          headers: { 'accept-language': language },
        });
        expect(status).toBe(200);
        const t = messagesFor(language);
        const byId = new Map(body.expectations.map((item) => [item.id, item]));
        expect(byId.get(RECLASSIFIED.id)?.closedReason).toBe(t.closedReasons['pregnancy_ended']);
        expect(byId.get(DONE.id)?.closedReason).toBe(t.closedReasons['covered_by_order']);
      },
    );

    it('the FHIR Task says pregnancy_ended and keeps the original closure', async () => {
      const { status, body } = await h.call<Task>(`/fhir/Task/${RECLASSIFIED.id}`);
      expect(status).toBe(200);
      expect(body.statusReason?.coding?.[0]?.code).toBe('pregnancy_ended');
      expect(body.executionPeriod?.end).toBe(CLOSED_AT.toISOString());
      const done = await h.call<Task>(`/fhir/Task/${DONE.id}`);
      expect(done.body.statusReason?.coding?.[0]?.code).toBe('covered_by_order');
    });

    it('stores the original closure untouched', async () => {
      const stored = await h.runtime.storage.stores.expectations.get(CLINIC, RECLASSIFIED.id);
      expect(stored).toEqual(RECLASSIFIED);
      expect(stored?.closedReason).toBe('covered_by_order');
    });
  });
}
