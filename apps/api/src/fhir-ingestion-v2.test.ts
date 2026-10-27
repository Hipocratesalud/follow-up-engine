import {
  buildConsultationBundle,
  type Bundle,
  type OperationOutcome,
} from '@follow-up-engine/fhir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/** HIP-134: FHIR ingestion v2 through the API (methods, all-failed batches, stale, searches, charsets). */

const NOW = new Date('2026-01-05T12:00:00Z');

function patient(id: string, versionId?: string): Record<string, unknown> {
  return {
    resourceType: 'Patient',
    id,
    ...(versionId === undefined ? {} : { meta: { versionId } }),
    name: [{ text: `Paciente ${id}` }],
  };
}

function put(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    resource,
    request: {
      method: 'PUT',
      url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
    },
  };
}

function labOrder(patientId: string, id: string): Record<string, unknown> {
  return {
    resourceType: 'ServiceRequest',
    id,
    status: 'active',
    intent: 'order',
    category: [
      { coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory' }] },
    ],
    code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' }] },
    subject: { reference: `Patient/${patientId}` },
    authoredOn: '2026-01-05T10:00:00Z',
  };
}

function statuses(bundle: Bundle): string[] {
  return (bundle.entry ?? []).map((entry) => entry.response?.status ?? '');
}

function outcomeOf(bundle: Bundle, index: number): OperationOutcome | undefined {
  return bundle.entry?.[index]?.response?.outcome as OperationOutcome | undefined;
}

describe.each(STORAGES)('FHIR ingestion v2 (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers DELETE and GET entries of a batch with 405, and a DELETE never creates', async () => {
    const response = await h.call<Bundle>('/fhir?sync=true', {
      fhir: true,
      body: {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [
          { request: { method: 'DELETE', url: 'ServiceRequest/del-sr0' } },
          {
            resource: labOrder('v2-del', 'del-sr1'),
            request: { method: 'DELETE', url: 'ServiceRequest/del-sr1' },
          },
          { request: { method: 'GET', url: 'Task?patient=v2-del' } },
          put(patient('v2-del')),
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('batch-response');
    expect(statuses(response.body)).toEqual([
      '405 Method Not Allowed',
      '405 Method Not Allowed',
      '405 Method Not Allowed',
      '201 Created',
    ]);
    expect(outcomeOf(response.body, 0)?.issue[0]).toMatchObject({
      severity: 'error',
      code: 'not-supported',
    });
    const tasks = await h.call<Bundle>('/fhir/Task?patient=v2-del');
    expect(tasks.body.total).toBe(0);
  });

  it('rejects a whole transaction with a DELETE entry', async () => {
    const response = await h.call<OperationOutcome>('/fhir?sync=true', {
      fhir: true,
      body: {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [put(patient('v2-tx')), { request: { method: 'DELETE', url: 'Patient/v2-tx' } }],
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.resourceType).toBe('OperationOutcome');
    const stored = await h.runtime.storage.stores.clinicalRecords.getResource(
      'clinic-demo' as never,
      {
        resourceType: 'Patient',
        id: 'v2-tx',
      },
    );
    expect(stored).toBeUndefined();
  });

  it.each(['?sync=true', ''])(
    'answers a batch whose entries all fail with a batch-response (%s)',
    async (query) => {
      const invalid = (id: string) => ({
        resource: { resourceType: 'Observation', id, status: 'final' },
        request: { method: 'PUT', url: `Observation/${id}` },
      });
      const response = await h.call<Bundle>(`/fhir${query}`, {
        fhir: true,
        body: { resourceType: 'Bundle', type: 'batch', entry: [invalid('bi1'), invalid('bi2')] },
      });
      expect(response.status).toBe(200);
      expect(response.body.type).toBe('batch-response');
      expect(statuses(response.body)).toEqual(['400 Bad Request', '400 Bad Request']);
      expect(outcomeOf(response.body, 1)?.issue[0]?.severity).toBe('error');
    },
  );

  it('marks a stale version in the entry response and in a header', async () => {
    expect(
      (await h.call('/fhir/Patient', { fhir: true, body: patient('v2-ver', '5') })).status,
    ).toBe(201);
    const single = await h.call<{ meta?: { versionId?: string } }>('/fhir/Patient', {
      fhir: true,
      body: patient('v2-ver', '3'),
    });
    expect(single.status).toBe(200);
    expect(single.headers.get('x-followup-stale')).toBe('true');
    const bundle = await h.call<Bundle>('/fhir?sync=true', {
      fhir: true,
      body: { resourceType: 'Bundle', type: 'transaction', entry: [put(patient('v2-ver', '4'))] },
    });
    expect(statuses(bundle.body)).toEqual(['200 OK']);
    expect(outcomeOf(bundle.body, 0)?.issue).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'conflict',
        details: { coding: [expect.objectContaining({ code: 'stale' })] },
      }),
    ]);
    expect(bundle.headers.get('x-followup-stale')).toBe('1');
    expect(bundle.headers.get('x-followup-summary')).toMatch(/1 stale version/);
  });

  it('reads a note with an invalid UTF-8 byte or a declared Latin-1 charset', async () => {
    const text = 'Paciente con DM2. Evolución estable.\nPlan: control en 2 semanas.';
    for (const [id, bytes, contentType] of [
      ['v2-bad', Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0xff])]), 'text/plain'],
      ['v2-latin', Buffer.from(text, 'latin1'), 'text/plain; charset=ISO-8859-1'],
    ] as const) {
      const bundle = buildConsultationBundle({
        consultationId: `c-${id}`,
        patient: { id, name: 'Paciente Prueba' },
        specialty: 'diabetology',
        occurredAt: NOW,
        noteText: 'placeholder',
      });
      const note = (bundle.entry ?? []).find(
        (entry) => entry.resource?.resourceType === 'DocumentReference',
      )?.resource as unknown as { content: { attachment: Record<string, unknown> }[] };
      note.content = [{ attachment: { contentType, data: bytes.toString('base64') } }];
      const response = await h.call<Bundle>('/fhir?sync=true', { fhir: true, body: bundle });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-followup-summary')).toMatch(/1 note\(s\) read/);
    }
  });

  describe('repeated search parameters', () => {
    beforeEach(async () => {
      for (const id of ['v2-q0', 'v2-q1']) {
        await h.call('/fhir?sync=true', {
          fhir: true,
          body: {
            resourceType: 'Bundle',
            type: 'transaction',
            entry: [put(patient(id)), put(labOrder(id, `${id}-sr`))],
          },
        });
      }
    });

    it('ORs comma-separated patients', async () => {
      const both = await h.call<Bundle>('/fhir/Task?patient=v2-q0,v2-q1');
      const one = await h.call<Bundle>('/fhir/Task?patient=v2-q0');
      expect(one.body.total).toBeGreaterThan(0);
      expect(both.body.total).toBe((one.body.total ?? 0) * 2);
    });

    it('ANDs repeated parameters with a warning, and refuses them with handling=strict', async () => {
      const and = await h.call<Bundle>('/fhir/Task?patient=v2-q0&status=requested&status=failed');
      expect(and.status).toBe(200);
      expect(and.body.total).toBe(0);
      const warning = and.body.entry?.find(
        (entry) => entry.resource?.resourceType === 'OperationOutcome',
      )?.resource as OperationOutcome | undefined;
      expect(warning?.issue).toContainEqual(
        expect.objectContaining({
          severity: 'warning',
          diagnostics: expect.stringMatching(/status/) as unknown,
        }),
      );
      const twoPatients = await h.call<Bundle>('/fhir/Condition?patient=v2-q0&patient=v2-q1');
      expect(twoPatients.status).toBe(200);
      for (const path of [
        '/fhir/Task?patient=v2-q0&status=requested&status=failed',
        '/fhir/Task?patient=v2-q0&patient=v2-q1',
        '/fhir/Condition?patient=v2-q0&patient=v2-q1',
      ]) {
        const strict = await h.call<OperationOutcome>(path, {
          headers: { prefer: 'handling=strict' },
        });
        expect({ path, status: strict.status }).toEqual({ path, status: 400 });
      }
    });
  });
});
