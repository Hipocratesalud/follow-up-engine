import { type ClinicalFinding, clinicId as toClinicId } from '@follow-up-engine/core';
import { labClinicId } from '@follow-up-engine/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BeforeVisitResponse } from './reviewer-schemas.ts';
import { createHarness, type Harness, KEY_A } from '../test/harness.ts';

/*
 * HIP-112 V3, "Before the visit": the next appointment and the open
 * pre_visit_question / abnormal_result_no_followup findings worth raising at
 * it. Shadow findings are included (and must be told apart from live ones)
 * only in the demo and lab clinics; a regular clinic sees live findings only.
 */

const PATIENT = 'before-visit-patient';
const LAB_KEY = 'before-visit-lab-key';
const LAB_CLINIC = labClinicId('before-visit@example.com');

function finding(overrides: Partial<ClinicalFinding>): ClinicalFinding {
  const now = new Date('2026-11-01T10:00:00.000Z');
  return {
    id: `finding-${Math.random().toString(36).slice(2)}`,
    clinicId: toClinicId('clinic-demo'),
    patientId: PATIENT as ClinicalFinding['patientId'],
    category: 'pre_visit_question',
    severity: 'low',
    summary: 'Ask about tingling in the feet',
    rationale: 'Patient with diabetes, no recent note about peripheral neuropathy.',
    suggestion: 'Ask at the next visit.',
    citations: [
      {
        source: { resourceType: 'Condition', id: 'cond-1' },
        kind: 'condition',
        quote: 'E11.9 Type 2 diabetes mellitus',
        occurredAt: now,
      },
    ],
    alreadyCovered: false,
    coveredBy: [],
    mode: 'shadow',
    status: 'open',
    origin: 'confirmed',
    dedupKey: 'pre_visit_question|Condition/cond-1',
    runId: 'run-before-visit',
    modelId: 'detector',
    promptVersion: 'detectors@1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function registerPatient(h: Harness, key: string): Promise<void> {
  await h.call('/fhir/Patient', {
    method: 'POST',
    fhir: true,
    key,
    body: { resourceType: 'Patient', id: PATIENT, name: [{ text: 'Before Visit Patient' }] },
  });
}

describe('GET /api/inbox/patients/:id/before-visit', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await h.runtime.registerClinic({ id: 'clinic-reg', name: 'Regular clinic', apiKey: 'reg-key' });
    await h.runtime.registerClinic({ id: LAB_CLINIC, name: 'Lab clinic', apiKey: LAB_KEY });
    await registerPatient(h, KEY_A);
    await registerPatient(h, 'reg-key');
    await registerPatient(h, LAB_KEY);

    for (const clinicId of ['clinic-demo', 'clinic-reg', LAB_CLINIC] as const) {
      await h.runtime.storage.stores.clinicalFindings.create(
        toClinicId(clinicId),
        finding({
          id: `${clinicId}-shadow`,
          clinicId: toClinicId(clinicId),
          mode: 'shadow',
          severity: 'low',
          category: 'pre_visit_question',
        }),
      );
      await h.runtime.storage.stores.clinicalFindings.create(
        toClinicId(clinicId),
        finding({
          id: `${clinicId}-live`,
          clinicId: toClinicId(clinicId),
          mode: 'live',
          severity: 'high',
          category: 'abnormal_result_no_followup',
          dedupKey: 'abnormal_result_no_followup|Observation/r1',
        }),
      );
    }
  });

  afterAll(async () => {
    await h.close();
  });

  it('includes shadow findings, clearly labeled, in the demo clinic', async () => {
    const response = await h.call<BeforeVisitResponse>(
      `/api/inbox/patients/${PATIENT}/before-visit`,
      { key: KEY_A },
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id).sort()).toEqual([
      'clinic-demo-live',
      'clinic-demo-shadow',
    ]);
    const shadow = response.body.items.find((item) => item.id === 'clinic-demo-shadow');
    expect(shadow?.mode).toBe('shadow');
  });

  it('includes shadow findings in a lab clinic', async () => {
    const response = await h.call<BeforeVisitResponse>(
      `/api/inbox/patients/${PATIENT}/before-visit`,
      { key: LAB_KEY },
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id).sort()).toEqual([
      `${LAB_CLINIC}-live`,
      `${LAB_CLINIC}-shadow`,
    ]);
  });

  it('shows only live findings in a regular clinic', async () => {
    const response = await h.call<BeforeVisitResponse>(
      `/api/inbox/patients/${PATIENT}/before-visit`,
      { key: 'reg-key' },
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.id)).toEqual(['clinic-reg-live']);
  });

  it('puts the highest severity first', async () => {
    const response = await h.call<BeforeVisitResponse>(
      `/api/inbox/patients/${PATIENT}/before-visit`,
      { key: KEY_A },
    );
    expect(response.body.items[0]?.severity).toBe('high');
    expect(response.body.items[1]?.severity).toBe('low');
  });

  it('has no appointment when the record has none', async () => {
    const response = await h.call<BeforeVisitResponse>(
      `/api/inbox/patients/${PATIENT}/before-visit`,
      { key: KEY_A },
    );
    expect(response.body.nextAppointmentAt).toBeUndefined();
  });

  it('404s for a patient that does not exist', async () => {
    const response = await h.call('/api/inbox/patients/nobody/before-visit', { key: KEY_A });
    expect(response.status).toBe(404);
  });
});
