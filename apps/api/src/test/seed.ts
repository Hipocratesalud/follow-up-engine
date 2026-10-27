import type { ClinicId } from '@follow-up-engine/core';
import { BASE_DATE, loadSyntheticClinic } from '@follow-up-engine/testkit';
import { type EngineRuntime, registerDemoClinic, Worker } from '@follow-up-engine/worker';

/*
 * Loads the synthetic demo clinic (packages/testkit, fictional patients
 * only) into a running engine: every patient's FHIR Bundles are ingested in
 * global chronological order, each with the fake clock set to the moment the
 * host would have sent it, exactly as live traffic would have arrived. Then
 * the clock stops at the end of the history (`BASE_DATE`) and the sweeps run,
 * so the inbox opens with the cases a real clinic would have today.
 */

export interface SeedOptions {
  readonly apiKey: string;
  /** Only the first N patients (by id). All 120 by default. */
  readonly patients?: number;
  /** Called every `every` bundles. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface SeedReport {
  readonly clinicId: ClinicId;
  readonly patients: number;
  readonly bundles: number;
  readonly expectationsCreated: number;
  readonly casesOpened: number;
  readonly notesFailed: number;
  readonly ms: number;
}

export async function seedSyntheticClinic(
  runtime: EngineRuntime,
  options: SeedOptions,
): Promise<SeedReport> {
  const clock = runtime.fakeClock;
  if (clock === undefined) {
    throw new Error('Seeding replays two years of history: run it with CLOCK=fake');
  }
  const started = performance.now();
  const clinic = await registerDemoClinic(runtime, options.apiKey);
  const synthetic = loadSyntheticClinic();
  const patients = [...synthetic.patients]
    .sort((left, right) => left.patientId.localeCompare(right.patientId))
    .slice(0, options.patients ?? synthetic.patients.length);

  const timeline = patients
    .flatMap((patient) => patient.entries)
    .sort((left, right) => left.at.localeCompare(right.at));

  // The clinic directory (organization, practitioners) arrives first, so the
  // inbox can name each case's treating practitioner.
  clock.set(new Date(timeline[0]?.at ?? BASE_DATE));
  await runtime.ingestion.accept(
    clinic.id,
    {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [synthetic.clinic.organization, ...synthetic.clinic.practitioners].map((resource) => ({
        resource,
        request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
      })),
    },
    'sync',
  );

  let expectationsCreated = 0;
  let notesFailed = 0;
  for (const [index, entry] of timeline.entries()) {
    clock.set(new Date(entry.at));
    const accepted = await runtime.ingestion.accept(clinic.id, entry.bundle, 'sync');
    for (const report of accepted.reports ?? []) {
      expectationsCreated += report.expectationsCreated.length;
      notesFailed += report.notes.filter((note) => note.status === 'failed').length;
    }
    if ((index + 1) % 100 === 0) {
      options.onProgress?.(index + 1, timeline.length);
    }
  }

  clock.set(BASE_DATE);
  const [sweep] = await new Worker(runtime).runSweeps([clinic.id]);
  return {
    clinicId: clinic.id,
    patients: patients.length,
    bundles: timeline.length,
    expectationsCreated,
    casesOpened: sweep?.watcher.casesOpened.length ?? 0,
    notesFailed,
    ms: Math.round(performance.now() - started),
  };
}
