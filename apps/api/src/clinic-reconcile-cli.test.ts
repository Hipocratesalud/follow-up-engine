import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clinicId, patientId } from '@follow-up-engine/core';
import { runClinicReconcileCommand } from './clinic-reconcile-cli.ts';
import { createHarness, FIXTURE_PATIENT, fixture, type Harness, STORAGES } from './test/harness.ts';

/** HIP-141: `clinic:reconcile`, the nightly reconciliation by hand. */

describe.each(STORAGES)('clinic:reconcile (%s)', (storage) => {
  let h: Harness;
  const run = (...argv: string[]) =>
    runClinicReconcileCommand(h.runtime, ['--clinic', 'clinic-demo', ...argv]);

  beforeEach(async () => {
    h = await createHarness({ storage });
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
  });
  afterEach(async () => {
    await h.close();
  });

  it('finds nothing to repair on a clean clinic, then resolves a case left without open reasons, and lists both', async () => {
    const clean = await run('--all');
    expect(clean.code).toBe(0);
    expect(clean.output).toMatch(/all completed: 1 patients, 0 repairs/);

    // A lost write: every reason of a case was closed, but the case was not resolved.
    await h.call('/api/demo/clock/advance', { body: { days: 20 } });
    const clinic = clinicId('clinic-demo');
    const expired = await h.runtime.storage.stores.expectations.listByPatient(
      clinic,
      patientId(FIXTURE_PATIENT),
      ['expired'],
    );
    const caseId = expired[0]?.caseId;
    if (caseId === undefined) {
      throw new Error('setup: the patient should have an expectation expired into a case');
    }
    await h.runtime.storage.unitOfWork.withTransaction(clinic, async (stores) => {
      for (const expectation of expired.filter((candidate) => candidate.caseId === caseId)) {
        await stores.expectations.update(clinic, {
          ...expectation,
          status: 'cancelled',
          closedReason: 'source_withdrawn',
          closedAt: h.runtime.clock.now(),
          updatedAt: h.runtime.clock.now(),
        });
      }
    });
    const repaired = await run('--all');
    expect(repaired.output).toMatch(/1 patients, [1-9]\d* repairs/);
    const runId = /^(\S+) all completed/m.exec(repaired.output)?.[1] ?? '';

    const runs = await run('--runs');
    expect(runs.output.split('\n')[0]).toContain(runId);
    const repairs = await run('--repairs', runId);
    expect(repairs.output).toMatch(new RegExp(`${FIXTURE_PATIENT}\\s+case_resolved`));
    expect((await run('--repairs', 'nope')).output).toBe('(no repairs)\n');
  });

  it('refuses a missing or unknown clinic', async () => {
    expect((await runClinicReconcileCommand(h.runtime, [])).code).toBe(1);
    expect((await runClinicReconcileCommand(h.runtime, ['--clinic', 'nope'])).output).toMatch(
      /Clinic nope does not exist/,
    );
  });
});
