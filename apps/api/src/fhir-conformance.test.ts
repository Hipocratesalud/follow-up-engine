import type {
  Bundle,
  CapabilityStatement,
  OperationOutcome,
  Patient,
  Task,
} from '@follow-up-engine/fhir';
import { Worker } from '@follow-up-engine/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHarness,
  fixture,
  FIXTURE_PATIENT,
  type Harness,
  KEY_B,
  STORAGES,
} from './test/harness.ts';

/** HIP-128: the FHIR API behaves as a FHIR R4 client expects. */

const EXPECTATION_SYSTEM = 'https://hipocratesalud.com/fhir/CodeSystem/follow-up-expectation';

function requestTypes(bundle: string): string[] {
  const parsed = JSON.parse(bundle) as { entry: { resource: { resourceType: string } }[] };
  return parsed.entry.map((entry) => entry.resource.resourceType);
}

const BATCH = {
  resourceType: 'Bundle',
  type: 'batch',
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        id: 'b2-obs',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
      },
      request: { method: 'PUT', url: 'Observation/b2-obs' },
    },
    {
      resource: { resourceType: 'Practitioner', id: 'b2-dr', name: [{ text: 'Dra. Prueba' }] },
      request: { method: 'PUT', url: 'Practitioner/b2-dr' },
    },
    {
      resource: { resourceType: 'Patient', id: 'b2-pat', name: [{ text: 'Paciente B2' }] },
      request: { method: 'PUT', url: 'Patient/b2-pat' },
    },
    {
      resource: { resourceType: 'Basic', id: 'b2-basic', code: { text: 'x' } },
      request: { method: 'PUT', url: 'Basic/b2-basic' },
    },
  ],
};

function tasks(bundle: Bundle): Task[] {
  return (bundle.entry ?? [])
    .filter((entry) => entry.search?.mode !== 'outcome')
    .map((entry) => entry.resource as Task);
}

function outcomes(bundle: Bundle): OperationOutcome[] {
  return (bundle.entry ?? [])
    .filter((entry) => entry.search?.mode === 'outcome')
    .map((entry) => entry.resource as OperationOutcome);
}

describe.each(STORAGES)('FHIR conformance (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('answers a transaction with one response entry per request entry, in order', async () => {
    const body = fixture('consultation-diabetology');
    const response = await h.call<Bundle>('/fhir', { body, fhir: true });
    expect(response.status).toBe(202);
    const entries = response.body.entry ?? [];
    const types = requestTypes(body);
    expect(entries).toHaveLength(types.length);
    entries.forEach((entry, index) => {
      expect(entry.resource).toBeUndefined();
      expect(entry.response?.location?.split('/')[0]).toBe(types[index]);
      expect(entry.response?.status).toBe('201 Created');
    });
    expect(response.headers.get('x-followup-summary')).toMatch(/queued/);
  });

  it('answers a batch entry by entry: failures get their own 4xx with an outcome', async () => {
    const response = await h.call<Bundle>('/fhir', { body: BATCH, fhir: true });
    expect(response.body.type).toBe('batch-response');
    const entries = response.body.entry ?? [];
    expect(entries.map((entry) => entry.response?.status.slice(0, 3))).toEqual([
      '400',
      '201',
      '201',
      '200',
    ]);
    const failed = entries[0]?.response?.outcome as OperationOutcome | undefined;
    expect(failed?.issue[0]).toMatchObject({
      severity: 'error',
      expression: ['Bundle.entry[0].resource.subject'],
    });
    expect(entries[1]?.response?.location).toMatch(/^Practitioner\/b2-dr\//);
    expect(entries[2]?.response?.location).toMatch(/^Patient\/b2-pat\//);
    const ignored = entries[3]?.response?.outcome as OperationOutcome | undefined;
    expect(ignored?.issue[0]?.severity).toBe('information');
  });

  it('pages Task searches with a next link and honors code systems', async () => {
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    const all = await h.call<Bundle>(`/fhir/Task?patient=${FIXTURE_PATIENT}`);
    const total = all.body.total ?? 0;
    expect(total).toBeGreaterThanOrEqual(2);

    const seen: string[] = [];
    let next: string | undefined = `/fhir/Task?patient=${FIXTURE_PATIENT}&_count=1`;
    while (next !== undefined) {
      const page: Bundle = (await h.call<Bundle>(next)).body;
      expect(page.total).toBe(total);
      seen.push(...tasks(page).map((task) => task.id ?? ''));
      const link = page.link?.find((candidate) => candidate.relation === 'next')?.url;
      next = link === undefined ? undefined : new URL(link).pathname + new URL(link).search;
      expect(seen.length).toBeLessThanOrEqual(total);
    }
    expect(new Set(seen).size).toBe(total);

    const counted = await h.call<Bundle>(`/fhir/Task?patient=${FIXTURE_PATIENT}&_count=0`);
    expect(counted.status).toBe(200);
    expect(counted.body.total).toBe(total);
    expect(tasks(counted.body)).toEqual([]);

    const wrongSystem = await h.call<Bundle>(
      `/fhir/Task?patient=${FIXTURE_PATIENT}&code=${encodeURIComponent('http://wrong|lab_order_result_pending')}`,
    );
    expect(wrongSystem.body.total).toBe(0);
    const rightSystem = await h.call<Bundle>(
      `/fhir/Task?patient=${FIXTURE_PATIENT}&code=${encodeURIComponent(`${EXPECTATION_SYSTEM}|lab_order_result_pending`)}`,
    );
    expect(rightSystem.body.total).toBeGreaterThan(0);
    const bySubject = await h.call<Bundle>(`/fhir/Task?subject=Patient/${FIXTURE_PATIENT}`);
    expect(bySubject.body.total).toBe(total);
  });

  it('reports unknown search parameters: a warning by default, a 400 with handling=strict', async () => {
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    const lenient = await h.call<Bundle>(`/fhir/Task?patient=${FIXTURE_PATIENT}&owner=someone`);
    expect(lenient.status).toBe(200);
    expect(outcomes(lenient.body)[0]?.issue[0]).toMatchObject({
      severity: 'warning',
      code: 'not-supported',
    });
    const strict = await h.call<OperationOutcome>(`/fhir/Task?owner=someone`, {
      headers: { prefer: 'handling=strict' },
    });
    expect(strict.status).toBe(400);
    expect(strict.body.resourceType).toBe('OperationOutcome');
    const condition = await h.call<OperationOutcome>(
      `/fhir/Condition?patient=${FIXTURE_PATIENT}&clinical-status=active`,
      { headers: { prefer: 'handling=strict' } },
    );
    expect(condition.status).toBe(400);
  });

  it('publishes an accurate CapabilityStatement without credentials', async () => {
    const response = await h.call<CapabilityStatement>('/fhir/metadata', { key: '' });
    expect(response.status).toBe(200);
    const statement = response.body;
    expect(statement.kind).toBe('instance');
    expect(statement.implementation?.url).toMatch(/\/fhir$/);
    const resources = statement.rest?.[0]?.resource ?? [];
    const types = resources.map((resource) => resource.type);
    expect(new Set(types).size).toBe(types.length);
    const condition = resources.find((resource) => resource.type === 'Condition');
    expect(condition?.interaction?.map((interaction) => interaction.code).sort()).toEqual([
      'create',
      'search-type',
      'update',
    ]);
    const task = resources.find((resource) => resource.type === 'Task');
    expect(task?.searchParam?.map((param) => param.name)).toContain('_count');

    // Every declared update really exists.
    const updated = await h.call<Patient>('/fhir/Patient/put-1', {
      method: 'PUT',
      body: { resourceType: 'Patient', id: 'put-1', name: [{ text: 'Paciente PUT' }] },
      fhir: true,
    });
    expect(updated.status).toBe(201);
    const mismatch = await h.call<OperationOutcome>('/fhir/Patient/put-2', {
      method: 'PUT',
      body: { resourceType: 'Patient', id: 'other', name: [{ text: 'x' }] },
      fhir: true,
    });
    expect(mismatch.status).toBe(400);
  });

  it('authenticates POST /fhir once', async () => {
    const lookup = vi.spyOn(h.runtime.storage.clinics, 'findByApiKeyHash');
    await h.call('/fhir', { body: fixture('consultation-diabetology'), fhir: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
  });

  it('lets the clinic poll the job of an asynchronous ingestion, and nobody else', async () => {
    const accepted = await h.call('/fhir', {
      body: fixture('consultation-diabetology'),
      fhir: true,
    });
    const jobId = accepted.headers.get('x-followup-job') ?? '';
    expect(jobId).not.toBe('');
    expect(accepted.headers.get('content-location')).toMatch(new RegExp(`/jobs/${jobId}$`));

    const pending = await h.call<{ id: string; status: string; attempts: number }>(
      `/jobs/${jobId}`,
    );
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ id: jobId, status: 'pending', attempts: 0 });
    expect((await h.call(`/jobs/${jobId}`, { key: KEY_B })).status).toBe(404);
    expect((await h.call('/jobs/not-a-job')).status).toBe(404);
    expect((await h.call(`/jobs/${jobId}`, { key: '' })).status).toBe(401);

    await new Worker(h.runtime).runJobs(1);
    const done = await h.call<{ status: string; attempts: number }>(`/jobs/${jobId}`);
    expect(done.body).toMatchObject({ status: 'completed', attempts: 1 });
  });
});
