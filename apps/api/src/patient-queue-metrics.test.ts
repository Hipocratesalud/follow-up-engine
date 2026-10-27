import type { Bundle } from '@follow-up-engine/fhir';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { validateFhirR4 } from '@follow-up-engine/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClinicMetricsView } from './metrics/schemas.ts';
import type { PatientQueueItem, PlanItemReviewResponse } from './http/patient-queue-schemas.ts';
import type { CaseDetail, PatientDetail } from './http/schemas.ts';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/*
 * HIP-141, the patient queue and plan item review meeting the metrics and
 * the booking attribution:
 *
 * - every plan item review counts in `GET /api/inbox/metrics`, including a
 *   confirmation made before the item became a case (the review log is the
 *   source, not the case trail);
 * - a contact request made once for the patient from their card opens one
 *   `CommunicationRequest`; a booking that names it is attributed to the
 *   patient contact and shows on the case history the card embeds.
 */

const ANA = 'pat-qm-ana';
const BRUNO = 'pat-qm-bruno';
const DAY_MS = 86_400_000;

interface Delivery {
  readonly type: string;
  readonly payload: { readonly data: Readonly<Record<string, unknown>> };
  readonly signatureValid: boolean;
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

describe.each(STORAGES)(
  'patient queue and plan item review in the metrics (%s)',
  { timeout: 60_000 },
  (storage) => {
    let h: Harness;

    beforeEach(async () => {
      h = await createHarness({ storage });
      await consult(h, ANA, 'Ana Metrics Mora');
      await consult(h, BRUNO, 'Bruno Metrics Paz');
    });
    afterEach(async () => {
      await h.close();
    });

    async function advance(days: number): Promise<void> {
      expect((await h.call('/api/demo/clock/advance', { body: { days } })).status).toBe(200);
    }

    async function metrics(): Promise<ClinicMetricsView> {
      const response = await h.call<ClinicMetricsView>('/api/inbox/metrics');
      expect(response.status).toBe(200);
      return response.body;
    }

    it('counts every confirm, correct and reject, a case or not', async () => {
      const before = await metrics();
      expect(before.extractionReviews.planItems).toMatchObject({ total: 0 });

      // Day 0: the plan item is open, in no case yet; the clinician confirms it.
      const patient = await h.call<PatientDetail>(`/api/inbox/patients/${ANA}`);
      const item = patient.body.expectations.find((e) => e.layer === 'doctor_plan');
      const base = `/api/inbox/plan-items/${item?.id ?? ''}`;
      const confirmed = await h.call<PlanItemReviewResponse>(`${base}/confirm`, {
        method: 'POST',
        headers: { 'X-FollowUp-User': 'dra-mora' },
      });
      expect(confirmed.status).toBe(200);
      expect((await metrics()).extractionReviews.planItems).toMatchObject({
        total: 1,
        confirmed: 1,
        corrected: 0,
        rejected: 0,
      });

      // Day 16: overdue in a case; corrected, then the correction rejected.
      await advance(16);
      const corrected = await h.call<PlanItemReviewResponse>(`${base}/correct`, {
        body: { kind: 'lab' },
      });
      expect(corrected.status).toBe(200);
      const replacement = corrected.body.replacement?.id ?? '';
      const rejected = await h.call<PlanItemReviewResponse>(
        `/api/inbox/plan-items/${replacement}/reject`,
        { method: 'POST' },
      );
      expect(rejected.status).toBe(200);

      const after = await metrics();
      expect(after.extractionReviews.planItems).toEqual({
        total: 3,
        confirmed: 1,
        corrected: 1,
        rejected: 1,
        correctionRate: 2 / 3,
      });
      // The case trail only saw what happened once the item was in a case.
      const caseId = rejected.body.casesResolved[0] ?? '';
      const detail = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`);
      const types = detail.body.timeline.map((entry) => entry.type);
      expect(types).toEqual(expect.arrayContaining(['plan_item_corrected', 'plan_item_rejected']));
      expect(types).not.toContain('plan_item_confirmed');
    });

    it('a patient-level contact request opens one CommunicationRequest; the booking it brings shows on the card', async () => {
      await advance(16);
      const card = await h.call<PatientQueueItem>(`/api/inbox/patients-queue/${BRUNO}`);
      expect(card.body.caseCount).toBe(2);
      const primary = card.body.cases[0]?.id ?? '';
      const contact = await h.call<PatientQueueItem>(
        `/api/inbox/patients-queue/${BRUNO}/request-contact`,
        { body: {} },
      );
      expect(contact.status).toBe(200);
      expect(contact.body.cases.map((item) => item.status)).toEqual(['notified', 'notified']);

      // One attempt for the patient, on their most urgent case, valid R4.
      const search = await h.call<Bundle>(`/fhir/CommunicationRequest?patient=${BRUNO}`);
      expect(validateFhirR4(search.body).issues).toEqual([]);
      expect(search.body.total).toBe(1);
      const request = search.body.entry?.[0]?.resource as Record<string, unknown> | undefined;
      expect(request).toMatchObject({
        status: 'active',
        basedOn: [{ reference: `Task/${primary}` }],
      });
      const requestId = String(request?.['id']);
      await h.runtime.storage.drainOutbox(h.runtime.publisher, h.runtime.clock.now(), 500);
      const webhooks = await h.call<{ items: Delivery[] }>(
        '/api/demo/webhooks?limit=200&type=patient_contact.requested',
      );
      const forBruno = webhooks.body.items.filter(
        (delivery) => delivery.payload.data['patientId'] === BRUNO,
      );
      expect(forBruno).toHaveLength(1);
      expect(forBruno[0]?.signatureValid).toBe(true);
      expect(forBruno[0]?.payload.data).toMatchObject({
        caseId: primary,
        communicationRequest: `CommunicationRequest/${requestId}`,
      });

      // The patient books after the contact: attributed to it.
      const start = new Date(h.runtime.clock.now().getTime() + 3 * DAY_MS).toISOString();
      const booked = await h.call('/fhir?sync=true', {
        fhir: true,
        body: {
          resourceType: 'Bundle',
          type: 'transaction',
          entry: [
            {
              resource: {
                resourceType: 'Appointment',
                id: `appt-${BRUNO}`,
                status: 'booked',
                start,
                basedOn: [{ reference: `CommunicationRequest/${requestId}` }],
                participant: [{ actor: { reference: `Patient/${BRUNO}` }, status: 'accepted' }],
              },
              request: { method: 'PUT', url: `Appointment/appt-${BRUNO}` },
            },
          ],
        },
      });
      expect(booked.status).toBe(200);

      // The card embeds the case detail: its history shows the booking.
      const english = await h.call<CaseDetail>(`/api/inbox/cases/${primary}`);
      const line = english.body.timeline.find((entry) => entry.type === 'appointment_booked');
      expect(line?.label).toMatch(/booked after the contact request/);
      const spanish = await h.call<CaseDetail>(`/api/inbox/cases/${primary}`, {
        headers: { 'accept-language': 'es' },
      });
      expect(
        spanish.body.timeline.find((entry) => entry.type === 'appointment_booked')?.label,
      ).toMatch(/agendada tras el pedido de contacto/);
      // The request covered both cases: the booking answers both, the one it
      // resolves (the control visit) included, not an organic booking there.
      const other = card.body.cases[1]?.id ?? '';
      const shared = await h.call<CaseDetail>(`/api/inbox/cases/${other}`);
      expect(shared.body.status).toBe('resolved');
      expect(
        shared.body.timeline.find((entry) => entry.type === 'appointment_booked')?.label,
      ).toMatch(/booked after the contact request/);
      expect((await metrics()).bookings.booked).toEqual({
        total: 2,
        followUpCase: 0,
        patientContact: 2,
        organic: 0,
      });
    });
  },
);
