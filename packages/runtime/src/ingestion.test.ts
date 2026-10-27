import { type ClinicId, patientId } from '@follow-up-engine/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';
import { Worker } from './worker.ts';

const CLINIC = 'clinic-demo' as ClinicId;
const PATIENT = 'p-out-of-order';

function order(input: { readonly status: string; readonly version: number; readonly at: string }) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: {
          resourceType: 'ServiceRequest',
          id: 'sr-out-of-order',
          meta: { versionId: String(input.version), lastUpdated: input.at },
          status: input.status,
          intent: 'order',
          category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
          subject: { reference: `Patient/${PATIENT}` },
          authoredOn: '2026-01-05T10:00:00Z',
        },
        request: { method: 'PUT', url: 'ServiceRequest/sr-out-of-order' },
      },
    ],
  };
}

describe('out-of-order delivery (HIP-116)', () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
  });

  it.each(['sync', 'async'] as const)(
    'an older version delivered after a newer one changes nothing (%s)',
    async (mode) => {
      runtime = await createRuntime(
        loadRuntimeConfig({ CLOCK: 'fake', LOG_LEVEL: 'silent', DEMO_API_KEY: 'demo-key' }),
      );
      const worker = new Worker(runtime);
      // Version 2 (revoked) first, then the stale version 1 (active).
      await runtime.ingestion.accept(
        CLINIC,
        order({ status: 'revoked', version: 2, at: '2026-01-06T10:00:00Z' }),
        mode,
      );
      await worker.runJobs();
      const late = await runtime.ingestion.accept(
        CLINIC,
        order({ status: 'active', version: 1, at: '2026-01-05T10:00:00Z' }),
        mode,
      );
      expect(late.stored).toMatchObject([{ changed: false, stale: true }]);
      await worker.runJobs();
      const stored = await runtime.storage.stores.clinicalRecords.getResource(CLINIC, {
        resourceType: 'ServiceRequest',
        id: 'sr-out-of-order',
      });
      expect(stored?.resource['status']).toBe('revoked');
      expect(
        await runtime.storage.stores.expectations.listByPatient(CLINIC, patientId(PATIENT)),
      ).toEqual([]);
    },
  );
});
