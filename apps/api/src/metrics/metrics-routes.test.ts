import type { Task } from '@follow-up-engine/fhir';
import { validateFhirR4 } from '@follow-up-engine/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseDetail, CaseView } from '../http/schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from '../test/harness.ts';
import { ClinicMetricsViewSchema, type ClinicMetricsView } from './schemas.ts';

/**
 * HIP-141 through the API: a pending lab order opens a case on day 15; the
 * team assigns it on day 16 and books a control from it (an Appointment
 * naming the case Task). `GET /api/inbox/metrics` reports it; the case
 * shows the booking on its timeline and the rule version of its reason;
 * the case Task carries that version per reason.
 */

const ORIGIN_CASE = 'https://hipocratesalud.com/fhir/StructureDefinition/follow-up-origin-case';
const REASON_RULE = 'https://hipocratesalud.com/fhir/StructureDefinition/follow-up-reason-rule';
const DAY_MS = 86_400_000;

function put(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    resource,
    request: {
      method: 'PUT',
      url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
    },
  };
}

function bundle(...resources: Record<string, unknown>[]): Record<string, unknown> {
  return { resourceType: 'Bundle', type: 'transaction', entry: resources.map(put) };
}

const patient = (id: string) => ({
  resourceType: 'Patient',
  id,
  name: [{ text: `Paciente ${id}` }],
});

function labOrder(patientId: string, at: Date): Record<string, unknown> {
  return {
    resourceType: 'ServiceRequest',
    id: `sr-${patientId}`,
    status: 'active',
    intent: 'order',
    category: [
      { coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory' }] },
    ],
    code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' }] },
    subject: { reference: `Patient/${patientId}` },
    authoredOn: at.toISOString(),
  };
}

function appointment(patientId: string, caseId: string, start: Date): Record<string, unknown> {
  return {
    resourceType: 'Appointment',
    id: `appt-${patientId}`,
    extension: [{ url: ORIGIN_CASE, valueReference: { reference: `Task/${caseId}` } }],
    status: 'booked',
    start: start.toISOString(),
    participant: [{ actor: { reference: `Patient/${patientId}` }, status: 'accepted' }],
  };
}

describe.each(STORAGES)(
  'clinic metrics through the API, HIP-141 (%s)',
  { timeout: 60_000 },
  (storage) => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness({ storage });
    });
    afterEach(async () => {
      await h.close();
    });

    async function advance(days: number): Promise<void> {
      expect((await h.call('/api/demo/clock/advance', { body: { days } })).status).toBe(200);
    }

    async function metrics(query = ''): Promise<ClinicMetricsView> {
      const response = await h.call<ClinicMetricsView>(`/api/inbox/metrics${query}`);
      expect(response.status).toBe(200);
      return ClinicMetricsViewSchema.parse(response.body);
    }

    async function openCase(patientId: string): Promise<string> {
      const sent = await h.call('/fhir?sync=true', {
        fhir: true,
        body: bundle(patient(patientId), labOrder(patientId, h.runtime.clock.now())),
      });
      expect(sent.status).toBe(200);
      await advance(15);
      const cases = await h.call<{ items: CaseView[] }>(
        `/api/inbox/cases?view=active&patient=${patientId}`,
      );
      const caseId = cases.body.items[0]?.id;
      if (caseId === undefined) throw new Error('expected a case');
      return caseId;
    }

    it('reports a booking attributed to the case and the time to the first action', async () => {
      const caseId = await openCase('pat-metrics');
      await advance(1);
      const assigned = await h.call(`/api/inbox/cases/${caseId}/actions`, {
        body: { action: 'notify' },
      });
      expect(assigned.status).toBe(200);
      const start = new Date(h.runtime.clock.now().getTime() + 3 * DAY_MS);
      const booked = await h.call('/fhir?sync=true', {
        fhir: true,
        body: bundle(appointment('pat-metrics', caseId, start)),
      });
      expect(booked.status).toBe(200);

      const body = await metrics();
      expect(body.cases).toMatchObject({ opened: 1, live: 1, active: 1 });
      // A booking does not fulfill a lab result: attributed to the case, not resolving it.
      expect(body.bookings).toMatchObject({
        booked: { total: 1, followUpCase: 1, patientContact: 0, organic: 0 },
        resolvedByBooking: { total: 0 },
        bookedRate: 1,
        attributedShare: 1,
      });
      expect(body.timeToFirstAction).toEqual({
        measured: 1,
        pending: 0,
        medianHours: 24,
        p75Hours: 24,
        p90Hours: 24,
      });
      // The default period ends at the engine clock, included.
      expect(new Date(body.period.to).getTime() - new Date(body.asOf).getTime()).toBe(1);
      expect(new Date(body.asOf).getTime()).toBe(h.runtime.clock.now().getTime());

      const detail = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`);
      expect(detail.body.timeline.map((entry) => entry.type)).toContain('appointment_booked');
      expect(
        detail.body.timeline.find((entry) => entry.type === 'appointment_booked')?.label,
      ).toMatch(/agendada desde este caso/);
      expect(detail.body.reasons[0]).toMatchObject({
        ruleId: 'lab_order_result_pending',
        ruleVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string,
      });

      // Another clinic sees none of it.
      const other = await h.call<ClinicMetricsView>('/api/inbox/metrics', { key: KEY_B });
      expect(other.status).toBe(200);
      expect(other.body.cases.opened).toBe(0);
    });

    it('a period before the case opened leaves it out', async () => {
      await openCase('pat-early');
      const from = new Date(h.runtime.clock.now().getTime() - 40 * DAY_MS).toISOString();
      const to = new Date(h.runtime.clock.now().getTime() - 10 * DAY_MS).toISOString();
      const body = await metrics(`?from=${from}&to=${to}`);
      expect(body.cases.opened).toBe(0);
      expect(body.period).toEqual({ from, to: new Date(to).toISOString() });
      expect(body.bookings).not.toHaveProperty('bookedRate');
    });

    it('refuses a period that does not make sense', async () => {
      const now = h.runtime.clock.now().toISOString();
      expect((await h.call(`/api/inbox/metrics?from=${now}&to=${now}`)).status).toBe(422);
      expect((await h.call('/api/inbox/metrics?from=yesterday')).status).toBe(422);
      const long = new Date(h.runtime.clock.now().getTime() - 1000 * DAY_MS).toISOString();
      expect((await h.call(`/api/inbox/metrics?from=${long}`)).status).toBe(422);
    });

    it('the case Task says which rule version produced each reason, valid R4', async () => {
      const caseId = await openCase('pat-version');
      const task = await h.call<Task>(`/fhir/Task/${caseId}`);
      expect(task.status).toBe(200);
      expect(validateFhirR4(task.body).issues).toEqual([]);
      expect(task.body.input?.[0]?.extension).toEqual([
        {
          url: REASON_RULE,
          extension: [
            { url: 'ruleId', valueCode: 'lab_order_result_pending' },
            { url: 'ruleVersion', valueString: expect.any(String) as string },
            { url: 'layer', valueCode: 'universal' },
          ],
        },
      ]);
      const search = await h.call<{ entry?: { resource: Task }[] }>(
        '/fhir/Task?patient=pat-version',
      );
      expect(validateFhirR4(search.body).issues).toEqual([]);
      expect(
        search.body.entry?.find((entry) => entry.resource.id === caseId)?.resource.input?.[0]
          ?.extension,
      ).toBeDefined();
    });
  },
);
