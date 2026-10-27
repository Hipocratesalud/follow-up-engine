import type { ClinicId, PatientId } from '@follow-up-engine/core';
import { DEMO_CLINIC, type EngineRuntime } from '@follow-up-engine/runtime';
import { loadReviewerCohort } from '@follow-up-engine/testkit';

/*
 * The clinical reviewer's shadow pilot on the demo clinic (PRD V3, HIP-112):
 * the reviewer cohort (synthetic patients with planted findings and their
 * controls) joins the clinic through the same initial backfill, then every
 * patient of the clinic gets one review, the way a clinic starting its
 * shadow pilot would run the reviewer once over its patients. Findings are
 * stored in shadow mode: the "Revisión clínica" batch review shows them,
 * nothing reaches doctors, the host or a patient.
 */

/** Fixed run id of the cohort's backfill: seeding again is a no-op. */
export const COHORT_RUN_ID = 'seed-reviewer-cohort';

export interface ReviewerSeedReport {
  readonly cohortPatients: number;
  readonly reviewed: number;
  readonly findings: number;
  readonly ms: number;
}

async function allPatients(runtime: EngineRuntime, clinicId: ClinicId): Promise<PatientId[]> {
  const ids: PatientId[] = [];
  let after: PatientId | undefined;
  do {
    const page = await runtime.storage.stores.clinicalRecords.listPatientIds(clinicId, {
      limit: 500,
      ...(after === undefined ? {} : { after }),
    });
    ids.push(...page.patientIds);
    after = page.next;
  } while (after !== undefined);
  return ids.filter((id) => !id.startsWith('_'));
}

export async function seedReviewerPilot(
  runtime: EngineRuntime,
  options: { readonly cohort?: boolean } = {},
): Promise<ReviewerSeedReport> {
  const started = performance.now();
  const clinicId = DEMO_CLINIC.id as ClinicId;
  let cohortPatients = 0;
  if (options.cohort ?? true) {
    const cohort = loadReviewerCohort();
    cohortPatients = cohort.patients.length;
    const previous = await runtime.engine.backfill.status(clinicId, COHORT_RUN_ID);
    if (previous?.status !== 'completed') {
      for (const patient of cohort.patients) {
        for (const entry of patient.entries) {
          await runtime.ingestion.stageHistory(clinicId, entry.bundle, new Date(entry.at));
        }
      }
      await runtime.engine.backfill.run(clinicId, { runId: COHORT_RUN_ID });
    }
  }
  let reviewed = 0;
  let findings = 0;
  for (const patientId of await allPatients(runtime, clinicId)) {
    const last = await runtime.storage.stores.reviewRuns.lastReviewedAt(clinicId, patientId);
    if (last !== undefined) continue;
    const report = await runtime.reviewer.reviewPatient(clinicId, patientId, 'initial');
    reviewed += 1;
    findings += report.findings.length;
  }
  return { cohortPatients, reviewed, findings, ms: Math.round(performance.now() - started) };
}
