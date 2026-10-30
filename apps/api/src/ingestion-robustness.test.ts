import {
  type Bundle,
  buildConsultationBundle,
  type OperationOutcome,
  type Task,
} from '@follow-up-engine/fhir';
import { Worker } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/** HIP-120: one bad field never costs the host a consultation, and nothing answers 500. */

const NOW = new Date('2026-01-05T12:00:00Z');

function consultation(
  patientId: string,
  options: { readonly noteText?: string; readonly occurredAt?: Date } = {},
): Bundle {
  return buildConsultationBundle({
    consultationId: `c-${patientId}`,
    patient: { id: patientId, name: 'Paciente Prueba' },
    specialty: 'diabetology',
    occurredAt: options.occurredAt ?? NOW,
    noteText: options.noteText ?? 'Paciente con DM2. Plan: control en 2 semanas.',
    orders: [{ loinc: '4548-4', display: 'HbA1c' }],
  });
}

function labOrderWithoutCategory(patientId: string, loinc: string, display: string): unknown {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: { resourceType: 'Patient', id: patientId, name: [{ text: 'Paciente Prueba' }] },
        request: { method: 'PUT', url: `Patient/${patientId}` },
      },
      {
        resource: {
          resourceType: 'ServiceRequest',
          id: `${patientId}-sr`,
          status: 'active',
          intent: 'order',
          code: { coding: [{ system: 'http://loinc.org', code: loinc, display }] },
          subject: { reference: `Patient/${patientId}` },
          authoredOn: '2026-01-05T10:00:00Z',
        },
        request: { method: 'PUT', url: `ServiceRequest/${patientId}-sr` },
      },
    ],
  };
}

function issuesOf(body: Bundle | OperationOutcome): OperationOutcome['issue'] {
  if (body.resourceType === 'OperationOutcome') {
    return body.issue;
  }
  return (body.entry ?? []).flatMap((entry): OperationOutcome['issue'] => {
    const outcome = entry.response?.outcome as OperationOutcome | undefined;
    const resource = entry.resource as OperationOutcome | undefined;
    return [
      ...(outcome?.issue ?? []),
      ...(resource?.resourceType === 'OperationOutcome' ? resource.issue : []),
    ];
  });
}

const FHIR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe.each(STORAGES)('ingestion robustness (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage, app: { maxBodyBytes: 64 * 1024 } });
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers an oversized body with 413, as an OperationOutcome under /fhir', async () => {
    const huge = consultation('pat-huge', { noteText: 'x'.repeat(80 * 1024) });
    const fhir = await h.call<OperationOutcome>('/fhir', { body: huge, fhir: true });
    expect(fhir.status).toBe(413);
    expect(fhir.body.resourceType).toBe('OperationOutcome');
    expect(fhir.body.issue[0]?.code).toBe('too-costly');
    const inbox = await h.call<{ error: { code: string } }>('/api/inbox/cases/x/feedback', {
      body: { useful: false, reason: 'other', comment: 'x'.repeat(80 * 1024) },
    });
    expect(inbox.status).toBe(413);
    expect(inbox.body.error.code).toBe('payload_too_large');
    expect((await h.call('/api/inbox/patients?query=pat-huge')).text.length).toBeLessThan(10_000);
  });

  it('strips a NUL character from a note and keeps the whole consultation', async () => {
    const bundle = consultation('pat-nul', {
      noteText: 'Paciente con DM2.\u0000\nPlan: control en 2 semanas. Solicito HbA1c.',
    });
    const response = await h.call<Bundle>('/fhir?sync=true', { body: bundle, fhir: true });
    expect(response.status).toBe(200);
    const again = consultation('pat-nul3', { noteText: 'Plan:\u0000 control en 2 semanas.' });
    expect((await h.call('/fhir', { body: again, fhir: true })).status).toBe(202);
    // The bundle, then the adjudication of its ambiguous plan item (shadow, demo clinic).
    expect(await new Worker(h.runtime).runJobs(1)).toEqual({ completed: 2, failed: 0 });
    const tasks = await h.call<Bundle>('/fhir/Task?patient=pat-nul');
    const codes = (tasks.body.entry ?? []).map(
      (entry) => (entry.resource as Task).code?.coding?.[0]?.code,
    );
    expect(codes).toContain('lab_order_result_pending');
  });

  it('strips control characters from any string, with a warning, and the async job succeeds', async () => {
    const bundle = consultation('pat-nul2');
    const patient = bundle.entry?.[0]?.resource as unknown as { name: { text: string }[] };
    patient.name = [{ text: 'Ana\u0000 Prueba\u0007' }];
    const accepted = await h.call<Bundle>('/fhir', { body: bundle, fhir: true });
    expect(accepted.status).toBe(202);
    expect(issuesOf(accepted.body)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        expression: ['Bundle.entry[0].resource.name[0].text'],
      }),
    );
    expect(await new Worker(h.runtime).runJobs(1)).toEqual({ completed: 1, failed: 0 });
    const single = await h.call<{ name: { text: string }[] }>('/fhir/Patient', {
      body: { resourceType: 'Patient', id: 'rb-nul-name', name: [{ family: 'A\u0000B' }] },
      fhir: true,
    });
    expect(single.status).toBe(201);
    expect(single.text).not.toContain('\\u0000');
  });

  it('rejects a clinical date outside the sane window with an OperationOutcome', async () => {
    const farFuture = consultation('pat-far', { occurredAt: new Date('9999-12-25T10:00:00Z') });
    const response = await h.call<OperationOutcome>('/fhir?sync=true', {
      body: farFuture,
      fhir: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.issue).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'value' }),
    );
    const tasks = await h.call<Bundle>('/fhir/Task?patient=pat-far');
    expect(tasks.body.total).toBe(0);
  });

  it('warns about a consultation dated in the future and keeps every Task valid R4', async () => {
    const future = consultation('pat-future', { occurredAt: new Date('2026-06-01T10:00:00Z') });
    const response = await h.call<Bundle>('/fhir?sync=true', { body: future, fhir: true });
    expect(response.status).toBe(200);
    expect(issuesOf(response.body)).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'value' }),
    );
    const tasks = await h.call<Bundle>('/fhir/Task?patient=pat-future');
    for (const entry of tasks.body.entry ?? []) {
      const task = entry.resource as Task;
      for (const instant of [task.authoredOn, task.restriction?.period?.end]) {
        if (instant !== undefined) {
          expect(instant).toMatch(FHIR_INSTANT);
        }
      }
    }
  });

  it('infers the laboratory category of an uncategorized LOINC lab order, with a warning', async () => {
    const response = await h.call<Bundle>('/fhir?sync=true', {
      body: labOrderWithoutCategory(
        'pat-glu',
        '2345-7',
        'Glucose [Mass/volume] in Serum or Plasma',
      ),
      fhir: true,
    });
    expect(response.status).toBe(200);
    expect(issuesOf(response.body)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        expression: ['Bundle.entry[1].resource.category'],
      }),
    );
    const tasks = await h.call<Bundle>('/fhir/Task?patient=pat-glu&code=lab_order_result_pending');
    expect(tasks.body.total).toBe(1);
  });

  it('warns when an uncategorized order creates nothing', async () => {
    const response = await h.call<Bundle>('/fhir?sync=true', {
      body: labOrderWithoutCategory('pat-unk', '99999-9', 'Something'),
      fhir: true,
    });
    expect(issuesOf(response.body)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        expression: ['Bundle.entry[1].resource.category'],
      }),
    );
  });

  it('answers invalid, crafted and cross-view cursors with 400 invalid_cursor', async () => {
    const crafted = (values: unknown[]): string =>
      Buffer.from(JSON.stringify(values)).toString('base64url');
    for (const cursor of [
      'garbage',
      'zzz',
      crafted(['priority', -1, 'notadate', 'x']),
      crafted(['priority', 1.5, '2026-01-01T00:00:00Z', 'x']),
      crafted(['created_at', '2026-01-01T00:00:00Z', 'x']),
    ]) {
      const response = await h.call<{ error: { code: string } }>(
        `/api/inbox/cases?cursor=${cursor}`,
      );
      expect({ cursor, status: response.status, code: response.body.error.code }).toEqual({
        cursor,
        status: 400,
        code: 'invalid_cursor',
      });
    }
  });

  it('answers NUL bytes in ids and parameters with 400, never 500', async () => {
    const fhir = await h.call<OperationOutcome>('/fhir/Task?patient=abc%00');
    expect(fhir.status).toBe(400);
    expect(fhir.body.resourceType).toBe('OperationOutcome');
    for (const path of ['/api/inbox/cases/abc%00', '/api/inbox/patients?query=a%00']) {
      const response = await h.call<{ error: { code: string } }>(path);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
    }
  });
});
